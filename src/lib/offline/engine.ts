import { backoffMs, retryAfterMs } from "./backoff";
import {
  LocalRuleError,
  applyAcknowledged,
  cleanNote,
  isWorkTransition,
  overlay,
  transitionNeedsNote,
} from "./rules";
import type { OfflineStore } from "./store";
import type { AttentionItem, CheckInLocation, JobStatus, QueuedOp, Snapshot, StoredSnapshot, SyncResult, SyncStatus, TechJob, WireOp } from "./types";

/**
 * The offline engine for one technician: the snapshot, the outbox and the flush loop, with no framework in it.
 * `useTechData()` (`use-tech-data.tsx`) is the React face of it.
 *
 * Contracts:
 * - **Nothing typed is lost.** `addNote` and `setStatus` resolve only after the op is in IndexedDB.
 * - **One intent, one op id.** The id is minted when the user acts and kept until the server answers (a retry or a double
 *   tap can't create a second op). A second status op on a job carries `dependsOn: <previous op id>` and the raised base.
 * - **Ops leave the outbox only on a final answer** (`applied`, `replayed`, `conflict`, `rejected`). A network error, a
 *   5xx, a 429, a 401 and `deferred` keep them. `conflict` and `rejected` are recorded in "Needs attention" first.
 * - **The outbox is bound to its user.** Every batch carries `ownerId`; the server refuses (409 `owner_mismatch`) a batch
 *   from another session user and the engine then wipes everything. A snapshot for a different user does the same.
 * - **One flush at a time** (a Web Lock across tabs, plus a single-flight promise), batches of at most 50 ops / 60 KB,
 *   exponential backoff with full jitter (2 s to 5 min, honouring `Retry-After`).
 */

export const MAX_BATCH_OPS = 50;
export const MAX_BATCH_BYTES = 60 * 1024;
export const FLUSH_DEBOUNCE_MS = 2000;
export const MAX_ROUNDS_PER_FLUSH = 10;

export type EngineEnv = {
  fetch: typeof fetch;
  now: () => number;
  random: () => number;
  newId: () => string;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** Run `fn` unless another tab is already flushing for this user (then resolve `undefined`). Defaults to no lock. */
  withLock?: <T>(name: string, fn: () => Promise<T>) => Promise<T | undefined>;
  /** Run `fn` holding an exclusive cross-tab lock (it waits its turn). Defaults to running at once (one tab, or no Web Locks). */
  exclusive?: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  /** Tells the other tabs of this user that the shared database changed (they reload), and hears the same from them. */
  broadcast?: { post: () => void; subscribe: (onChange: () => void) => () => void };
  /** Delete every local trace (databases, caches). Called when the session user turns out to be someone else. */
  wipe: () => Promise<void>;
  /** Called once when the engine stops (unmount, sign-out, wipe), so a registry can forget it. */
  onHalt?: (engine: TechDataEngine) => void;
};

export type EngineState = {
  ready: boolean;
  userId: string;
  jobs: TechJob[];
  hasSnapshot: boolean;
  truncated: boolean;
  snapshotSavedAt: number | null;
  pending: number;
  attention: AttentionItem[];
  status: SyncStatus;
  lastSyncedAt: number | null;
  nextRetryAt: number | null;
};

const initialState = (userId: string): EngineState => ({
  ready: false,
  userId,
  jobs: [],
  hasSnapshot: false,
  truncated: false,
  snapshotSavedAt: null,
  pending: 0,
  attention: [],
  status: "idle",
  lastSyncedAt: null,
  nextRetryAt: null,
});

/** Take ops from the front of the queue up to the op and byte limits (always at least one). */
export function takeBatch(queue: QueuedOp[], maxOps = MAX_BATCH_OPS, maxBytes = MAX_BATCH_BYTES): QueuedOp[] {
  const batch: QueuedOp[] = [];
  let bytes = 0;
  for (const q of queue) {
    const size = new TextEncoder().encode(JSON.stringify(q.op)).length + 1;
    if (batch.length > 0 && (batch.length >= maxOps || bytes + size > maxBytes)) break;
    batch.push(q);
    bytes += size;
  }
  return batch;
}

export class TechDataEngine {
  private state: EngineState;
  private listeners = new Set<() => void>();
  private snapshot: StoredSnapshot | null = null;
  private queue: QueuedOp[] = [];
  private timer: unknown = null;
  private attempts = 0;
  private flushing: Promise<void> | null = null;
  private halted = false;
  /** Why the current backoff started: a network error ends when the browser says it is online again; a server answer (429, 5xx) doesn't. */
  private backoffKind: "network" | "server" | null = null;
  /** Which refresh may still write: only the newest one started. */
  private refreshSeq = 0;
  /** Writers of the shared snapshot (a refresh applying, acknowledged ops folding in, a reload) take turns in this tab. */
  private storeChain: Promise<unknown> = Promise.resolve();
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly store: OfflineStore,
    private readonly env: EngineEnv,
  ) {
    this.state = initialState(store.userId);
  }

  get userId() {
    return this.store.userId;
  }

  // -- external store -------------------------------------------------------------------------------------------------

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = () => this.state;

  private set(patch: Partial<EngineState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  private rebuild(extra: Partial<EngineState> = {}) {
    this.set({
      jobs: overlay(this.snapshot?.jobs ?? [], this.queue),
      hasSnapshot: this.snapshot !== null,
      truncated: this.snapshot?.truncated ?? false,
      snapshotSavedAt: this.snapshot?.savedAt ?? null,
      pending: this.queue.length,
      ...extra,
    });
  }

  // -- lifecycle ------------------------------------------------------------------------------------------------------

  /** Read the saved snapshot, outbox and attention list. Works with no network; call before anything renders data. */
  async load(): Promise<void> {
    this.snapshot = await this.store.getSnapshot();
    this.queue = await this.store.outbox();
    const attention = await this.store.attention();
    this.rebuild({ ready: true, attention });
    // Another tab of this user changed the database: take its state (the screen follows it, and our next intent builds on it).
    this.unsubscribe = this.env.broadcast?.subscribe(() => void this.locked(() => this.reloadLocal()).catch(() => undefined)) ?? null;
    if (this.queue.length > 0) this.scheduleFlush(FLUSH_DEBOUNCE_MS);
  }

  private locked<T>(work: () => Promise<T>): Promise<T> {
    const run = this.storeChain.then(work, work);
    this.storeChain = run.catch(() => undefined);
    return run;
  }

  /** Re-read the snapshot, outbox and attention list from IndexedDB, the one copy every tab shares. Call inside `locked`. */
  private async reloadLocal(): Promise<void> {
    if (this.halted) return;
    this.snapshot = await this.store.getSnapshot();
    this.queue = await this.store.outbox();
    this.rebuild({ attention: await this.store.attention() });
  }

  private announce() {
    this.env.broadcast?.post();
  }

  /** Stop all work and release the database. After this the engine does nothing (a wipe may be deleting the database). */
  halt() {
    this.halted = true;
    if (this.timer !== null) this.env.clearTimer(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.store.close();
    this.set({ status: "wiped", ready: false });
    this.env.onHalt?.(this);
  }

  get isHalted() {
    return this.halted;
  }

  // -- actions --------------------------------------------------------------------------------------------------------

  private job(jobId: string): TechJob {
    const job = this.state.jobs.find((j) => j.id === jobId);
    if (!job) throw new LocalRuleError("no_such_job", "That job isn't on this phone any more.");
    return job;
  }

  /**
   * User intents run one at a time, from reading the local state to having it stored and rebuilt: two taps that overlap
   * (before the first IndexedDB write finishes) would otherwise both read the same `statusVersion` and `dependsOn`.
   */
  private intents: Promise<unknown> = Promise.resolve();
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    // In this tab one at a time; across tabs under a Web Lock, starting from what is in IndexedDB (not this tab's memory):
    // another tab may have queued or flushed since, and the base version and dependsOn must follow it.
    const guarded = () => {
      const inside = () => this.locked(() => this.reloadLocal()).then(work);
      return this.env.exclusive ? this.env.exclusive(`fsd-intent-${this.userId}`, inside) : inside();
    };
    const run = this.intents.then(guarded, guarded);
    this.intents = run.catch(() => undefined);
    return run;
  }

  private async enqueue(op: WireOp, job: TechJob): Promise<string> {
    const item = { op, label: `#${job.number} ${job.title}`.slice(0, 160), createdAt: this.env.now() };
    await this.store.enqueue(item);
    this.queue = await this.store.outbox();
    this.rebuild();
    this.announce();
    this.scheduleFlush(FLUSH_DEBOUNCE_MS);
    return op.opId;
  }

  /** Queue a note. Pass the same `opId` on a retry of the same tap. Resolves with the op id once it is stored. */
  addNote(jobId: string, body: string, opId?: string): Promise<string> {
    return this.serialize(async () => {
      const text = cleanNote(body);
      const job = this.job(jobId);
      if (job.status === "cancelled") throw new LocalRuleError("job_cancelled", "This job was cancelled.");
      return this.enqueue({ kind: "note.add", opId: opId ?? this.env.newId(), jobId, clientAt: new Date(this.env.now()).toISOString(), body: text }, job);
    });
  }

  /**
   * Queue a status change. `location` is only for `on_site` and only from the explicit "Check in at site" tap.
   * The base is the job's *local* `statusVersion` (raised by this phone's own queued status ops) and a second op on the
   * same job depends on the previous one.
   */
  setStatus(jobId: string, to: JobStatus, opts: { location?: CheckInLocation | null; opId?: string } = {}): Promise<string> {
    return this.serialize(async () => {
      const job = this.job(jobId);
      if (opts.location && to !== "on_site") throw new LocalRuleError("location_only_on_site", "A location can only be sent when checking in on site.");
      if (!isWorkTransition(job.status, to)) throw new LocalRuleError("transition_not_allowed", `A ${job.status.replace("_", " ")} job can't move to ${to.replace("_", " ")}.`);
      // `notesTruncated` means older notes exist that did not fit the snapshot: the server has them, so do not refuse here.
      if (transitionNeedsNote(to) && job.notes.length === 0 && !job.notesTruncated) throw new LocalRuleError("note_required", "Add a note about the work before you do that.");
      const previous = [...this.queue].reverse().find((q) => q.op.kind === "status.set" && q.op.jobId === jobId);
      return this.enqueue(
        {
          kind: "status.set",
          opId: opts.opId ?? this.env.newId(),
          jobId,
          clientAt: new Date(this.env.now()).toISOString(),
          to,
          baseStatusVersion: job.statusVersion,
          dependsOn: previous ? previous.op.opId : null,
          ...(opts.location ? { location: opts.location } : {}),
        },
        job,
      );
    });
  }

  async dismissAttention(opId: string): Promise<void> {
    await this.store.dismissAttention(opId);
    this.set({ attention: await this.store.attention() });
    this.announce();
  }

  // -- network --------------------------------------------------------------------------------------------------------

  scheduleFlush(ms: number) {
    if (this.halted) return;
    // Work queued during a backoff waits for the deadline: a 2 s debounce must not undo a 2-minute Retry-After.
    const { status, nextRetryAt } = this.state;
    const wait = status === "backoff" && nextRetryAt !== null ? Math.max(ms, nextRetryAt - this.env.now()) : ms;
    if (this.timer !== null) this.env.clearTimer(this.timer);
    this.timer = this.env.setTimer(() => {
      this.timer = null;
      void this.flush().catch(() => undefined);
    }, wait);
  }

  /** The browser says the network is back: a backoff that was only a network error ends now (a 429 or 5xx keeps its deadline). */
  connectivityRestored(): Promise<void> {
    if (this.state.status === "backoff" && this.backoffKind === "network") this.set({ nextRetryAt: null });
    void this.refresh();
    return this.flush();
  }

  /**
   * Send the outbox. Safe to call any time; one flush runs at a time. Automatic callers (timers, events) respect the
   * backoff deadline and stay quiet after a 401 or 403; `force` (the technician's "sync now") doesn't.
   */
  flush(opts: { force?: boolean } = {}): Promise<void> {
    if (this.halted) return Promise.resolve();
    if (!opts.force && (this.state.status === "signed_out" || this.state.status === "forbidden")) return Promise.resolve();
    if (!opts.force && this.state.status === "backoff" && this.state.nextRetryAt !== null && this.env.now() < this.state.nextRetryAt) return Promise.resolve();
    if (this.flushing) return this.flushing;
    const run = async () => {
      try {
        const lock = this.env.withLock;
        if (lock) await lock(`fsd-flush-${this.userId}`, () => this.flushLocked());
        else await this.flushLocked();
      } catch (err) {
        // A wipe closes the database under a running flush: that is expected. Anything else (IndexedDB failing) is a
        // retryable fault, never an unhandled rejection that leaves the outbox unsent.
        if (!this.halted) this.backoff();
        else void err;
      } finally {
        this.flushing = null;
      }
    };
    this.flushing = run();
    return this.flushing;
  }

  private backoff(retryAfter: number | null = null, kind: "network" | "server" = "server") {
    this.backoffKind = kind;
    this.attempts += 1;
    const wait = Math.max(backoffMs(this.attempts - 1, this.env.random), retryAfter ?? 0);
    this.set({ status: "backoff", nextRetryAt: this.env.now() + wait });
    this.scheduleFlush(wait);
  }

  private async ownerChanged() {
    this.halt();
    await this.env.wipe();
  }

  private async flushLocked(): Promise<void> {
    let singleOp = false;
    let finalAnswers = 0;
    for (let round = 0; round < MAX_ROUNDS_PER_FLUSH && !this.halted; round++) {
      this.queue = await this.store.outbox();
      if (this.queue.length === 0) break;
      const batch = takeBatch(this.queue, singleOp ? 1 : MAX_BATCH_OPS);
      this.set({ status: "syncing" });
      let res: Response;
      try {
        res = await this.env.fetch("/api/sync", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          cache: "no-store",
          body: JSON.stringify({ ownerId: this.userId, ops: batch.map((q) => q.op) }),
        });
      } catch {
        this.backoff(null, "network");
        return;
      }
      if (this.halted) return;

      if (res.status === 401) {
        this.set({ status: "signed_out" });
        return;
      }
      if (res.status === 403) {
        this.set({ status: "forbidden" });
        return;
      }
      if (res.status === 429) {
        this.backoff(retryAfterMs(res.headers.get("retry-after")));
        return;
      }
      if (res.status === 409) {
        const body = (await res.json().catch(() => ({}))) as { code?: string };
        if (body.code === "owner_mismatch") {
          await this.ownerChanged();
          return;
        }
        this.backoff(); // "retry": the database picked this request to lose a lock race
        return;
      }
      if (res.status === 400 || res.status === 413) {
        if (batch.length > 1) {
          singleOp = true; // find the offender: one op per request
          continue;
        }
        // One op the server will never accept: keep what was typed where the technician can see it, and move on.
        const q = batch[0];
        await this.store.settle([q.op.opId], [{ opId: q.op.opId, op: q.op, label: q.label, outcome: "rejected", code: "invalid_op", at: this.env.now() }]);
        finalAnswers++;
        this.rebuild({ attention: await this.store.attention() });
        continue;
      }
      if (!res.ok) {
        this.backoff();
        return;
      }

      let body: { results?: SyncResult[] };
      try {
        body = (await res.json()) as { results?: SyncResult[] };
      } catch {
        this.backoff();
        return;
      }
      const results = new Map((body.results ?? []).map((r) => [r.opId, r]));
      const done: string[] = [];
      const answered: { op: WireOp; result: SyncResult }[] = [];
      const attention: AttentionItem[] = [];
      let deferred = 0;
      for (const q of batch) {
        const r = results.get(q.op.opId);
        if (!r || r.outcome === "deferred") {
          deferred++;
          continue;
        }
        done.push(q.op.opId);
        answered.push({ op: q.op, result: r });
        if (r.outcome === "conflict" || r.outcome === "rejected") {
          attention.push({ opId: q.op.opId, op: q.op, label: q.label, outcome: r.outcome, code: r.code ?? "unknown", job: r.job, at: this.env.now() });
        }
      }
      // What the answers did goes into the saved snapshot in the same commit that removes the ops from the outbox. The
      // snapshot is read fresh (another tab may have refreshed it) and its `rev` moves, so a GET that began earlier is dropped.
      await this.locked(async () => {
        const current = await this.store.getSnapshot();
        // `etag: null` forces the next refresh to be a full read: our fold is an approximation of what the server now holds.
        const folded = current
          ? { ...current, etag: null, rev: (current.rev ?? 0) + 1, jobs: applyAcknowledged(current.jobs, answered, new Date(this.env.now()).toISOString()) }
          : undefined;
        await this.store.settle(done, attention, folded);
        if (folded) this.snapshot = folded;
      });
      this.announce();
      finalAnswers += done.length;
      this.queue = await this.store.outbox();
      if (done.length > 0) this.attempts = 0; // only progress resets the backoff: all-deferred answers keep growing it
      this.rebuild({ attention: await this.store.attention(), lastSyncedAt: this.env.now(), nextRetryAt: null, status: "idle" });
      if (deferred > 0 && done.length === 0) {
        this.backoff(); // the server made no progress (time budget or a busy job): wait, don't hammer
        return;
      }
    }
    if (finalAnswers > 0 && !this.halted) {
      // The server's state moved: take it back so statusVersion and notes catch up with what was applied.
      await this.refresh();
    }
    if (this.halted) return;
    if (this.state.status === "syncing") this.set({ status: "idle" });
    // More than one flush's worth was waiting: carry on shortly (a backoff, a 401 or a halt has already decided otherwise).
    this.queue = await this.store.outbox();
    if (this.queue.length > 0 && this.state.status === "idle") this.scheduleFlush(FLUSH_DEBOUNCE_MS);
  }

  /**
   * Fetch `/api/my/jobs` (conditional on the saved ETag) and keep it. Offline or failing: keep what's saved.
   * A response is applied only if it is still the newest request and no acknowledged ops were folded in since it began:
   * a GET that read the state before a sync and arrives after it would otherwise put the old state back (and with it an
   * old `statusVersion` for the next op). A response dropped for that reason is simply asked for again, once.
   */
  async refresh(retry = true): Promise<void> {
    if (this.halted) return;
    const seq = ++this.refreshSeq;
    const startRev = this.snapshot?.rev ?? 0;
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.snapshot?.etag) headers["if-none-match"] = this.snapshot.etag;
    let res: Response;
    try {
      res = await this.env.fetch("/api/my/jobs", { headers, credentials: "same-origin", cache: "no-store" });
    } catch {
      return;
    }
    if (this.halted) return;
    if (res.status === 401) return void this.set({ status: "signed_out" });
    if (res.status === 403) return void this.set({ status: "forbidden" });
    let body: Snapshot | null = null;
    if (res.status !== 304 && res.ok) {
      try {
        body = (await res.json()) as Snapshot;
      } catch {
        return;
      }
    }
    if (this.halted) return;
    if (seq !== this.refreshSeq) return; // a newer refresh is in flight and will deliver
    if (body && (typeof body.userId !== "string" || !Array.isArray(body.jobs))) return;
    if (body && body.userId !== this.userId) {
      await this.ownerChanged();
      return;
    }
    if (!body && res.status !== 304) return;
    const etag = res.headers.get("etag");
    let stale = false;
    await this.locked(async () => {
      const current = await this.store.getSnapshot();
      // Acknowledged ops were folded in (here or in another tab) since this request began: it read older state.
      if ((current?.rev ?? 0) !== startRev) {
        stale = true;
        return;
      }
      if (body === null) {
        if (!current) return;
        this.snapshot = { ...current, savedAt: this.env.now() };
      } else {
        this.snapshot = { ...body, savedAt: this.env.now(), etag, rev: current?.rev ?? 0 };
      }
      await this.store.putSnapshot(this.snapshot);
      this.rebuild();
    });
    if (stale) {
      await this.locked(() => this.reloadLocal()); // take the folded state, then ask once more
      if (retry) return this.refresh(false);
      return;
    }
    this.announce();
  }
}
