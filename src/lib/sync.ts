import "server-only";
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { assertCan } from "@/lib/access";
import { assertActorCurrent } from "@/lib/actor-current";
import type { Actor } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { BadRequestError, ConflictError, HttpError, NotFoundError } from "@/lib/errors";
import { JOB_STATUSES, StatusRuleError } from "@/lib/job-status";
import { locationInput } from "@/lib/location";
import { log } from "@/lib/log";
import { appendNote, applyStatusChange, lockJob } from "@/lib/service-jobs";
import { idText, jsonHasNul, text } from "@/lib/text";
import { consumeRate, releaseRateEvent, type Tx } from "@/lib/usage";

/**
 * POST /api/sync (13.2): the offline technician's write channel. Two op kinds, nothing else: `note.add` and `status.set`.
 *
 * Rules that hold for every op:
 * - **Exactly once.** Each op is one transaction that first claims (actor, `op_id`) in `sync_op` (the replay ledger), then
 *   works under the job's row lock, then stores its result in the same row. A replay (same op id, same payload hash)
 *   returns the stored result and writes nothing; the same op id with another payload is `rejected: op_id_reused` and
 *   changes nothing. Two batches carrying the same op id wait on the ledger row, so only one applies it.
 * - **Per-op outcomes, never a failed batch.** `applied`, `replayed`, `conflict` (the office changed the job, or a rule
 *   refused: the result says why and carries the server's state), `rejected` (invalid, not allowed, no longer yours) and
 *   `deferred` (not processed: resend as is). A malformed envelope, a NUL byte or a duplicate op id in one batch is a 400
 *   for the whole request (a bug or tampering, never a user action).
 * - **Order.** Ops run in array order, one at a time. Once one op is deferred (the 8 s budget, or a lock wait over 3 s)
 *   every later op in the batch is deferred too, so a `dependsOn` chain can't be applied out of order.
 * - **Access.** Technician only; each op re-reads the acting user (`for share`) and locks only a job assigned to them.
 *   A missing job and someone else's answer the same (`not_assigned`), so ids can't be probed.
 * - **Lock order** is the app's: user row (share), then the job row (`lockJob`), then cap locks (`caps.ts`; this file takes
 *   none). The ledger row is per (actor, op) and is only waited on by a batch carrying the same op id.
 * - **Rate.** One `sync` unit per request (30 per technician per hour), spent after the envelope validates and refunded when
 *   nothing new was processed (a pure replay or a fully deferred request), so lost responses don't eat the allowance.
 */

export const SYNC_MAX_OPS = 50;
export const SYNC_BODY_LIMIT = 64 * 1024;
/** Stop starting new ops after this long (the Lambda limit is 29 s; the database pool is 2 connections). */
export const SYNC_BUDGET_MS = 8000;
export const SYNC_LIMIT_PER_HOUR = 30;
/** A lock wait longer than this defers the op (and the rest of the batch) instead of holding the request. */
export const SYNC_LOCK_TIMEOUT_MS = 3000;

const { syncOp } = schema;

export class SyncError extends HttpError {
  constructor(
    status: number,
    readonly code: string,
    message: string,
  ) {
    super(status, message);
  }
}

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

const uuid = z.string().uuid();
const clientAt = z.iso.datetime({ offset: true });

const noteOp = z.strictObject({
  kind: z.literal("note.add"),
  opId: uuid,
  jobId: uuid,
  clientAt,
  body: text(2000, { min: 1, minMessage: "Note is empty" }),
});

const statusOp = z.strictObject({
  kind: z.literal("status.set"),
  opId: uuid,
  jobId: uuid,
  clientAt,
  to: z.enum(JOB_STATUSES),
  /** The `statusVersion` the tech's screen showed (raised locally by their own queued status ops). */
  baseStatusVersion: z.number().int().min(1).max(2_000_000_000),
  /** The earlier status op this one builds on; it must have been `applied` or this op is a `conflict`. */
  dependsOn: uuid.nullish(),
  /** Only with `to: "on_site"`, and only from the explicit "Check in at site" tap. */
  location: locationInput.optional(),
});

const opSchema = z.discriminatedUnion("kind", [noteOp, statusOp]);
export type SyncOpInput = z.input<typeof opSchema>;
type ParsedOp = z.infer<typeof opSchema>;

const envelope = z
  .strictObject({
    /** The user the device's local database belongs to. A different session user means nothing is processed (409). */
    ownerId: idText,
    deviceId: text(64).optional(),
    ops: z.array(z.looseObject({ opId: uuid })).min(1).max(SYNC_MAX_OPS),
  })
  .superRefine((v, ctx) => {
    if (new Set(v.ops.map((o) => o.opId)).size !== v.ops.length) ctx.addIssue({ code: "custom", path: ["ops"], message: "Duplicate op id in one batch" });
  });

export type SyncOutcome = "applied" | "replayed" | "conflict" | "rejected" | "deferred";

/** Small on purpose: the stored result must fit the ledger's 2 KB check. The client re-reads the snapshot for the rest. */
export type JobBrief = { id: string; status: (typeof JOB_STATUSES)[number]; statusVersion: number; version: number };

export type SyncResult = {
  opId: string;
  outcome: SyncOutcome;
  /** Why a `conflict` or `rejected` (stable): see `SYNC_CODES`. */
  code?: string;
  /** True on a replay whose stored outcome is `conflict` or `rejected` (a replayed `applied` has outcome `replayed`). */
  replayed?: true;
  /** The server's state of the job after this op, when the actor still owns it. */
  job?: JobBrief;
  noteId?: string;
};

export const SYNC_CODES = [
  "not_assigned",
  "job_cancelled",
  "stale_version",
  "dependency_unmet",
  "transition_not_allowed",
  "job_closed",
  "note_required",
  "note_limit",
  "invalid_op",
  "op_id_reused",
] as const;

type Stored = { code?: string; job?: JobBrief; noteId?: string };
type Applied = { outcome: "applied" | "conflict" | "rejected" } & Stored;

const hashOf = (op: ParsedOp): string => {
  const payload =
    op.kind === "note.add"
      ? [op.body, op.clientAt]
      : [op.to, op.baseStatusVersion, op.dependsOn ?? null, op.clientAt, op.location ? [op.location.lat, op.location.lng, op.location.accuracyM, op.location.capturedAt] : null];
  return createHash("sha256").update(JSON.stringify([op.kind, op.jobId, payload])).digest("hex");
};

type JobRow = Awaited<ReturnType<typeof lockJob>>;
const brief = (j: JobRow): JobBrief => ({ id: j.id, status: j.status, statusVersion: j.statusVersion, version: j.version });

function pgCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur && typeof cur === "object"; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// One op
// ---------------------------------------------------------------------------

async function applyOp(tx: Tx, actor: Actor, op: ParsedOp): Promise<Applied> {
  let job: JobRow;
  try {
    job = await lockJob(tx, actor, op.jobId);
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err;
    // Missing, someone else's, or reassigned away: one answer. A note's text stays on the device ("Needs attention").
    return op.kind === "note.add" ? { outcome: "rejected", code: "not_assigned" } : { outcome: "conflict", code: "not_assigned" };
  }

  if (op.kind === "note.add") {
    if (job.status === "cancelled") return { outcome: "rejected", code: "job_cancelled", job: brief(job) };
    try {
      // A savepoint: a refused note leaves nothing behind, and the ledger row below still commits.
      const note = await tx.transaction((sp) => appendNote(sp, job, actor.id, { body: op.body, opId: op.opId, clientAt: new Date(op.clientAt) }));
      return { outcome: "applied", noteId: note.id, job: brief(job) };
    } catch (err) {
      if (err instanceof ConflictError) return { outcome: "rejected", code: "note_limit", job: brief(job) };
      throw err;
    }
  }

  if (job.status === "cancelled") return { outcome: "conflict", code: "job_cancelled", job: brief(job) };
  if (op.dependsOn) {
    const [dep] = await tx
      .select({ kind: syncOp.kind, jobId: syncOp.jobId, outcome: syncOp.outcome })
      .from(syncOp)
      .where(and(eq(syncOp.actorId, actor.id), eq(syncOp.opId, op.dependsOn)));
    // `outcome` is null for this op's own claim, so depending on itself is unmet too.
    if (!dep || dep.kind !== "status.set" || dep.jobId !== op.jobId || dep.outcome !== "applied") {
      return { outcome: "conflict", code: "dependency_unmet", job: brief(job) };
    }
  }
  if (job.statusVersion !== op.baseStatusVersion) return { outcome: "conflict", code: "stale_version", job: brief(job) };

  try {
    const updated = await tx.transaction((sp) =>
      applyStatusChange(sp, actor, job, op.to, { location: op.location, clientAt: new Date(op.clientAt), opId: op.opId }),
    );
    return { outcome: "applied", job: brief(updated) };
  } catch (err) {
    if (err instanceof StatusRuleError) {
      return { outcome: err.code === "note_required" ? "rejected" : "conflict", code: err.code, job: brief(job) };
    }
    if (err instanceof BadRequestError) return { outcome: "rejected", code: "invalid_op", job: brief(job) };
    throw err;
  }
}

async function runOp(actor: Actor, op: ParsedOp, deviceId: string | null): Promise<SyncResult> {
  const hash = hashOf(op);
  return db().transaction(async (tx) => {
    await tx.execute(sql`select set_config('lock_timeout', ${String(SYNC_LOCK_TIMEOUT_MS)}, true)`);
    await assertActorCurrent(tx, actor);
    const claimed = await tx
      .insert(syncOp)
      .values({ actorId: actor.id, opId: op.opId, deviceId, kind: op.kind, jobId: op.jobId, payloadHash: hash })
      .onConflictDoNothing()
      .returning({ opId: syncOp.opId });
    if (claimed.length === 0) {
      // Waited for any concurrent holder of this op id above, so the row is committed and final now.
      const [prev] = await tx.select().from(syncOp).where(and(eq(syncOp.actorId, actor.id), eq(syncOp.opId, op.opId)));
      if (!prev || !prev.outcome) throw new ConflictError("That was busy. Try again.");
      if (prev.kind !== op.kind || prev.jobId !== op.jobId || prev.payloadHash !== hash) return { opId: op.opId, outcome: "rejected", code: "op_id_reused" };
      const stored = (prev.result ?? {}) as Stored;
      return prev.outcome === "applied"
        ? { opId: op.opId, outcome: "replayed", ...stored }
        : { opId: op.opId, outcome: prev.outcome, replayed: true, ...stored };
    }
    const { outcome, ...stored } = await applyOp(tx, actor, op);
    await tx.update(syncOp).set({ outcome, result: stored }).where(and(eq(syncOp.actorId, actor.id), eq(syncOp.opId, op.opId)));
    return { opId: op.opId, outcome, ...stored };
  });
}

// ---------------------------------------------------------------------------
// The batch
// ---------------------------------------------------------------------------

export type SyncResponse = { results: SyncResult[]; serverTime: string };

/** Parse one op. `null` means the op is invalid (a per-op `rejected: invalid_op`; nothing is stored for it). */
export function parseOp(raw: unknown): ParsedOp | null {
  const parsed = opSchema.safeParse(raw);
  if (!parsed.success) return null;
  const op = parsed.data;
  if (op.kind === "status.set" && op.location && op.to !== "on_site") return null;
  return op;
}

export async function syncBatch(
  actor: Actor,
  input: unknown,
  opts: { budgetMs?: number; clock?: () => number } = {},
): Promise<SyncResponse> {
  assertCan(actor, "create", "sync");
  if (jsonHasNul(input)) throw new BadRequestError("Text can't contain null characters");
  const data = envelope.parse(input);
  if (data.ownerId !== actor.id) {
    throw new SyncError(409, "owner_mismatch", "This device's saved data belongs to another account.");
  }
  const clock = opts.clock ?? Date.now;
  const budget = opts.budgetMs ?? SYNC_BUDGET_MS;
  const started = clock();

  // Spend one flush. Over the limit is a 429 and nothing is processed.
  const rateEventId = await db().transaction(async (tx) => {
    await assertActorCurrent(tx, actor);
    return consumeRate(tx, actor.id, "sync", SYNC_LIMIT_PER_HOUR, "Too many syncs. Try again in a few minutes.");
  });

  const results: SyncResult[] = [];
  let deferRest = false;
  let counts = { applied: 0, conflict: 0, rejected: 0, replayed: 0, deferred: 0 };
  let fresh = 0;
  try {
    for (const raw of data.ops) {
      const opId = raw.opId;
      if (deferRest || clock() - started >= budget) {
        deferRest = true;
        results.push({ opId, outcome: "deferred" });
        continue;
      }
      const op = parseOp(raw);
      if (!op) {
        results.push({ opId, outcome: "rejected", code: "invalid_op" });
        continue;
      }
      try {
        results.push(await runOp(actor, op, data.deviceId ?? null));
      } catch (err) {
        if (pgCode(err) !== "55P03") throw err; // lock_not_available: the job is busy, try again later
        deferRest = true;
        results.push({ opId, outcome: "deferred" });
      }
    }
    for (const r of results) {
      const key = r.replayed ? "replayed" : r.outcome;
      counts = { ...counts, [key]: counts[key] + 1 };
      if (r.outcome !== "deferred" && !r.replayed && r.outcome !== "replayed") fresh++;
    }
  } catch (err) {
    // Ops that committed before the failure replay for free on the retry; nothing new to charge for if none did.
    if (results.every((r) => r.outcome === "deferred" || r.outcome === "replayed" || r.replayed)) await refund(actor, rateEventId);
    throw err;
  }
  if (fresh === 0) await refund(actor, rateEventId);
  log.info("sync.batch", { ops: data.ops.length, ...counts, ms: clock() - started });
  return { results, serverTime: new Date().toISOString() };
}

async function refund(actor: Actor, eventId: string): Promise<void> {
  try {
    await db().transaction((tx) => releaseRateEvent(tx, actor.id, "sync", eventId));
  } catch {
    log.warn("sync.refund_failed", {});
  }
}
