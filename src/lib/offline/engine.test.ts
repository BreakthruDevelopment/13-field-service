import { describe, expect, it, vi } from "vitest";
import { BACKOFF_MAX_MS } from "./backoff";
import { MAX_BATCH_OPS, takeBatch } from "./engine";
import { LocalRuleError } from "./rules";
import { job, reply, rig, snapshotFor } from "./test-helpers";
import type { SyncResult, WireOp } from "./types";

const USER = "user-1";
const J = "11111111-1111-4111-8111-111111111111";

type Handler = (url: string, init?: RequestInit) => Promise<Response> | Response;
const sentOps = (r: ReturnType<typeof rig>, call = 0): WireOp[] => JSON.parse(String(r.fetch.mock.calls.filter((c) => c[0] === "/api/sync")[call][1]?.body)).ops;
const syncCalls = (r: ReturnType<typeof rig>) => r.fetch.mock.calls.filter((c) => c[0] === "/api/sync").length;

/** A server that applies everything and serves a snapshot. */
const happy =
  (extra: Partial<Record<string, Handler>> = {}): Handler =>
  (url, init) => {
    if (extra[url]) return extra[url]!(url, init);
    if (url === "/api/sync") {
      const ops = JSON.parse(String(init?.body)).ops as WireOp[];
      return reply(200, { results: ops.map((o): SyncResult => ({ opId: o.opId, outcome: "applied" })), serverTime: "t" });
    }
    return reply(200, { userId: USER, serverTime: "t", jobs: [job()], truncated: false }, { etag: 'W/"v2"' });
  };

async function started(handler: Handler = happy(), jobs = [job()]) {
  const r = rig(vi, handler);
  const seed = await r.open(USER);
  // Put a snapshot in the database the way a refresh would have.
  await (seed as unknown as { store: { putSnapshot: (s: unknown) => Promise<void> } }).store.putSnapshot(snapshotFor(USER, jobs, r.clock.t));
  (seed as unknown as { store: { close: () => void } }).store.close();
  const engine = await r.open(USER);
  await engine.load();
  return { r, engine };
}

describe("queueing", () => {
  it("addNote resolves only once the op is stored; it survives a reload and shows as pending", async () => {
    const { r, engine } = await started();
    await engine.addNote(J, "  Replaced the cartridge.  ");
    expect(engine.getState().pending).toBe(1);
    expect(engine.getState().jobs[0].notes.at(-1)).toMatchObject({ body: "Replaced the cartridge.", pending: true, byMe: true });
    expect(engine.getState().jobs[0].pendingOps).toBe(1);
    engine.halt();
    const again = await r.open(USER);
    await again.load();
    expect(again.getState().pending).toBe(1);
    expect(again.getState().jobs[0].notes.at(-1)?.body).toBe("Replaced the cartridge.");
  });

  it("works with no network at all (nothing is fetched while queueing)", async () => {
    const { r, engine } = await started(() => {
      throw new Error("offline");
    });
    await engine.addNote(J, "typed in a basement");
    await engine.setStatus(J, "en_route");
    expect(engine.getState().pending).toBe(2);
    expect(r.fetch).not.toHaveBeenCalled();
  });

  it("strips NUL bytes, refuses empty and over-long notes, and unknown jobs", async () => {
    const { engine } = await started();
    await engine.addNote(J, "a\0b");
    expect(engine.getState().jobs[0].notes.at(-1)?.body).toBe("ab");
    await expect(engine.addNote(J, " \0 ")).rejects.toMatchObject({ code: "empty_note" });
    await expect(engine.addNote(J, "x".repeat(2001))).rejects.toMatchObject({ code: "note_too_long" });
    await expect(engine.addNote("nope", "x")).rejects.toBeInstanceOf(LocalRuleError);
  });

  it("a second status op on a job depends on the first and carries the raised base", async () => {
    const { engine, r } = await started();
    const a = await engine.setStatus(J, "en_route");
    const b = await engine.setStatus(J, "on_site", { location: { lat: 30.2672, lng: -97.7431, accuracyM: 12, capturedAt: "2026-11-15T10:00:00.000Z" } });
    expect(engine.getState().jobs[0]).toMatchObject({ status: "on_site", statusVersion: 3 }); // two queued status ops raise it twice
    await engine.flush();
    const [opA, opB] = sentOps(r) as Extract<WireOp, { kind: "status.set" }>[];
    expect(opA).toMatchObject({ opId: a, to: "en_route", baseStatusVersion: 1, dependsOn: null });
    expect(opB).toMatchObject({ opId: b, to: "on_site", baseStatusVersion: 2, dependsOn: a });
    expect(opB.location).toMatchObject({ lat: 30.2672 });
  });

  it("checks the status rules locally: no illegal move, no completing without a note, location only on_site", async () => {
    const { engine } = await started();
    await expect(engine.setStatus(J, "completed")).rejects.toMatchObject({ code: "transition_not_allowed" });
    await engine.setStatus(J, "on_site");
    await expect(engine.setStatus(J, "completed")).rejects.toMatchObject({ code: "note_required" });
    await expect(engine.setStatus(J, "on_hold")).rejects.toMatchObject({ code: "note_required" });
    await engine.addNote(J, "done");
    await expect(engine.setStatus(J, "completed")).resolves.toBeTruthy();
    await expect(engine.setStatus(J, "on_site", { location: { lat: 1, lng: 1, accuracyM: 1, capturedAt: "x" } })).rejects.toBeInstanceOf(LocalRuleError);
  });

  it("the same op id from a retried tap queues one op", async () => {
    const { engine } = await started();
    await engine.addNote(J, "once", "00000000-0000-4000-8000-0000000000aa");
    await engine.addNote(J, "once", "00000000-0000-4000-8000-0000000000aa");
    expect(engine.getState().pending).toBe(1);
  });

  it("refuses a note on a job the snapshot says is cancelled", async () => {
    const { engine } = await started(happy(), [job({ status: "cancelled" })]);
    await expect(engine.addNote(J, "x")).rejects.toMatchObject({ code: "job_cancelled" });
  });
});

describe("flushing", () => {
  it("sends the outbox in one request and removes the ops that were applied, then refreshes", async () => {
    const { engine, r } = await started();
    await engine.addNote(J, "one");
    await engine.addNote(J, "two");
    await engine.flush();
    expect(syncCalls(r)).toBe(1);
    expect(sentOps(r)).toHaveLength(2);
    expect(JSON.parse(String(r.fetch.mock.calls[0][1]?.body)).ownerId).toBe(USER);
    expect(engine.getState().pending).toBe(0);
    expect(engine.getState().status).toBe("idle");
    expect(r.fetch.mock.calls.map((c) => c[0])).toEqual(["/api/sync", "/api/my/jobs"]);
  });

  it("keeps every op on a network error, a 5xx and a 429 and backs off with jitter (honouring Retry-After)", async () => {
    for (const failure of [
      () => {
        throw new TypeError("Failed to fetch");
      },
      () => reply(503, { error: "x" }),
      () => reply(500, { error: "x" }),
      () => reply(409, { code: "retry" }),
    ]) {
      const { engine, r } = await started((url) => (url === "/api/sync" ? failure() : reply(200, {})));
      await engine.addNote(J, "keep me");
      await engine.flush();
      expect(engine.getState().pending).toBe(1);
      expect(engine.getState().status).toBe("backoff");
      const retry = r.timers.filter((t) => !t.cleared).at(-1)!;
      expect(retry.ms).toBeGreaterThanOrEqual(1000);
      expect(retry.ms).toBeLessThanOrEqual(BACKOFF_MAX_MS);
    }
    const { engine, r } = await started((url) => (url === "/api/sync" ? reply(429, { error: "slow down" }, { "retry-after": "120" }) : reply(200, {})));
    await engine.addNote(J, "keep me");
    await engine.flush();
    expect(engine.getState().pending).toBe(1);
    expect(r.timers.filter((t) => !t.cleared).at(-1)!.ms).toBeGreaterThanOrEqual(120_000);
    // The retry timer fires at the deadline and sends the same op again.
    const before = sentOps(r)[0].opId;
    r.clock.t += 120_001;
    r.timers.filter((t) => !t.cleared).at(-1)!.fn();
    await vi.waitFor(() => expect(syncCalls(r)).toBe(2));
    expect(sentOps(r, 1)[0].opId).toBe(before);
  });

  it("backoff grows with each failed attempt and resets after a success", async () => {
    let ok = false;
    const { engine, r } = await started((url, init) => (url === "/api/sync" && !ok ? reply(503, {}) : happy()(url, init)));
    await engine.addNote(J, "x");
    const waits: number[] = [];
    for (let i = 0; i < 4; i++) {
      r.clock.t += 10 * 60_000; // past each deadline
      await engine.flush();
      waits.push(r.timers.filter((t) => !t.cleared).at(-1)!.ms);
    }
    expect(waits).toEqual([...waits].sort((a, b) => a - b));
    expect(waits[3]).toBeGreaterThan(waits[0]);
    ok = true;
    r.clock.t += 10 * 60_000;
    await engine.flush();
    expect(engine.getState().pending).toBe(0);
  });

  it("a 401 pauses without losing anything; a 403 too; automatic flushes stay quiet until forced", async () => {
    for (const [status, expected] of [[401, "signed_out"], [403, "forbidden"]] as const) {
      const { engine, r } = await started((url) => (url === "/api/sync" ? reply(status, { error: "x" }) : reply(200, {})));
      await engine.addNote(J, "keep");
      await engine.flush();
      expect(engine.getState()).toMatchObject({ status: expected, pending: 1 });
      await engine.flush();
      expect(syncCalls(r)).toBe(1);
      await engine.flush({ force: true });
      expect(syncCalls(r)).toBe(2);
    }
  });

  it("removes ops only on a final answer: deferred stays, applied and replayed go, conflict and rejected go to Needs attention", async () => {
    let call = 0;
    const { engine, r } = await started((url, init) => {
      if (url !== "/api/sync") return reply(200, { userId: USER, serverTime: "t", jobs: [job()], truncated: false });
      const ops = JSON.parse(String(init?.body)).ops as WireOp[];
      call++;
      const outcomes: SyncResult[] =
        call === 1
          ? [
              { opId: ops[0].opId, outcome: "applied" },
              { opId: ops[1].opId, outcome: "rejected", code: "not_assigned" },
              { opId: ops[2].opId, outcome: "conflict", code: "stale_version", job: { id: J, status: "en_route", statusVersion: 4, version: 9 } },
              { opId: ops[3].opId, outcome: "deferred" },
              { opId: ops[4].opId, outcome: "deferred" },
            ]
          : ops.map((o) => ({ opId: o.opId, outcome: "replayed" as const }));
      return reply(200, { results: outcomes, serverTime: "t" });
    });
    await engine.addNote(J, "applied");
    await engine.addNote(J, "text that must be kept");
    await engine.setStatus(J, "en_route");
    await engine.addNote(J, "d1");
    await engine.addNote(J, "d2");
    await engine.flush();
    expect(syncCalls(r)).toBe(2); // the deferred two were sent again
    expect(sentOps(r, 1).map((o) => (o as { body?: string }).body)).toEqual(["d1", "d2"]);
    expect(engine.getState().pending).toBe(0);
    const att = engine.getState().attention;
    expect(att.map((a) => [a.outcome, a.code])).toEqual([["rejected", "not_assigned"], ["conflict", "stale_version"]]);
    expect(att[0].op).toMatchObject({ kind: "note.add", body: "text that must be kept" });
    expect(att[0].label).toBe("#7 Kitchen sink");
    expect(att[1].job).toMatchObject({ status: "en_route", statusVersion: 4 });
    await engine.dismissAttention(att[0].opId);
    expect(engine.getState().attention).toHaveLength(1);
  });

  it("if the server makes no progress (everything deferred) it backs off instead of hammering", async () => {
    const { engine, r } = await started((url, init) =>
      url === "/api/sync" ? reply(200, { results: (JSON.parse(String(init?.body)).ops as WireOp[]).map((o) => ({ opId: o.opId, outcome: "deferred" })), serverTime: "t" }) : reply(200, {}),
    );
    await engine.addNote(J, "x");
    await engine.flush();
    expect(syncCalls(r)).toBe(1);
    expect(engine.getState()).toMatchObject({ pending: 1, status: "backoff" });
  });

  it("splits a batch the server answers 400 into single ops, and keeps an op it will never accept where the technician can see it", async () => {
    const { engine } = await started((url, init) => {
      if (url !== "/api/sync") return reply(200, {});
      const ops = JSON.parse(String(init?.body)).ops as (WireOp & { body?: string })[];
      if (ops.length > 1) return reply(400, { error: "Invalid input" });
      if (ops[0].body === "poison") return reply(400, { error: "Invalid input" });
      return reply(200, { results: [{ opId: ops[0].opId, outcome: "applied" }], serverTime: "t" });
    });
    await engine.addNote(J, "fine");
    await engine.addNote(J, "poison");
    await engine.addNote(J, "also fine");
    await engine.flush();
    expect(engine.getState().pending).toBe(0);
    expect(engine.getState().attention).toMatchObject([{ code: "invalid_op", op: { body: "poison" } }]);
  });

  it("batches of at most 50 ops, in order, across several requests", async () => {
    const { engine, r } = await started();
    for (let i = 0; i < 120; i++) await engine.addNote(J, `n${i}`);
    await engine.flush();
    expect(sentOps(r, 0)).toHaveLength(MAX_BATCH_OPS);
    expect(sentOps(r, 2)).toHaveLength(20);
    expect(engine.getState().pending).toBe(0);
    const bodies = [0, 1, 2].flatMap((i) => sentOps(r, i).map((o) => (o as { body: string }).body));
    expect(bodies).toEqual(Array.from({ length: 120 }, (_, i) => `n${i}`));
  });

  it("takeBatch honours the byte limit and always takes at least one op", () => {
    const op = (i: number): { op: WireOp; label: string; createdAt: number } => ({ op: { kind: "note.add", opId: String(i), jobId: "j", clientAt: "c", body: "x".repeat(2000) }, label: "", createdAt: 0 });
    const queue = Array.from({ length: 50 }, (_, i) => op(i));
    const batch = takeBatch(queue, 50, 64 * 1024);
    expect(batch.length).toBeLessThan(50);
    expect(new TextEncoder().encode(JSON.stringify(batch.map((q) => q.op))).length).toBeLessThanOrEqual(64 * 1024);
    expect(takeBatch(queue, 50, 10)).toHaveLength(1);
  });

  it("two flushes at once send once", async () => {
    const { engine, r } = await started();
    await engine.addNote(J, "x");
    await Promise.all([engine.flush(), engine.flush(), engine.flush()]);
    expect(syncCalls(r)).toBe(1);
  });

  it("queueing schedules a flush after 2 s; a later tap reschedules it", async () => {
    const { engine, r } = await started();
    await engine.addNote(J, "a");
    await engine.addNote(J, "b");
    const live = r.timers.filter((t) => !t.cleared);
    expect(live).toHaveLength(1);
    expect(live[0].ms).toBe(2000);
  });
});

describe("owner binding", () => {
  it("a 409 owner_mismatch wipes everything and stops the engine, with nothing applied", async () => {
    const { engine, r } = await started((url) => (url === "/api/sync" ? reply(409, { error: "x", code: "owner_mismatch" }) : reply(200, {})));
    await engine.addNote(J, "belongs to someone else's session");
    await engine.flush();
    expect(r.wiped.n).toBe(1);
    expect(engine.isHalted).toBe(true);
    expect(engine.getState().status).toBe("wiped");
  });

  it("a snapshot for a different user wipes everything instead of being kept", async () => {
    const { engine, r } = await started(() => reply(200, { userId: "another-user", serverTime: "t", jobs: [job()], truncated: false }));
    await engine.refresh();
    expect(r.wiped.n).toBe(1);
    expect(engine.isHalted).toBe(true);
  });

  it("a halted engine does nothing: no queueing side effects, no fetches", async () => {
    const { engine, r } = await started();
    engine.halt();
    await engine.flush();
    await engine.refresh();
    expect(r.fetch).not.toHaveBeenCalled();
  });
});

describe("refresh", () => {
  it("sends the saved ETag, treats 304 as 'unchanged' and keeps the data", async () => {
    const { engine, r } = await started((url) => (url === "/api/my/jobs" ? new Response(null, { status: 304 }) : reply(200, {})));
    await engine.refresh();
    expect((r.fetch.mock.calls[0][1]?.headers as Record<string, string>)["if-none-match"]).toBe('W/"abc"');
    expect(engine.getState().jobs).toHaveLength(1);
    expect(engine.getState().snapshotSavedAt).toBe(r.clock.t);
  });

  it("offline keeps the saved snapshot; a new one replaces it and its ETag is kept", async () => {
    const { engine, r } = await started(() => {
      throw new Error("offline");
    });
    await engine.refresh();
    expect(engine.getState().jobs[0].title).toBe("Kitchen sink");
    r.fetch.mockImplementation(async () => reply(200, { userId: USER, serverTime: "t", jobs: [job({ title: "Renamed" })], truncated: false }, { etag: 'W/"new"' }));
    await engine.refresh();
    expect(engine.getState().jobs[0].title).toBe("Renamed");
    await engine.refresh();
    expect((r.fetch.mock.calls.at(-1)![1]?.headers as Record<string, string>)["if-none-match"]).toBe('W/"new"');
  });

  it("pending ops stay on top of a refreshed snapshot", async () => {
    const { engine, r } = await started();
    await engine.setStatus(J, "en_route");
    r.fetch.mockImplementation(async () => reply(200, { userId: USER, serverTime: "t", jobs: [job({ version: 4 })], truncated: false }));
    await engine.refresh();
    expect(engine.getState().jobs[0]).toMatchObject({ status: "en_route", statusVersion: 2, version: 4, pendingOps: 1 });
  });
});

describe("faults", () => {
  it("a failing IndexedDB during a flush backs off instead of leaking a rejection", async () => {
    const { engine, r } = await started();
    await engine.addNote(J, "x");
    const store = (engine as unknown as { store: { outbox: () => Promise<unknown> } }).store;
    vi.spyOn(store, "outbox").mockRejectedValueOnce(new Error("quota"));
    await expect(engine.flush()).resolves.toBeUndefined();
    expect(engine.getState().status).toBe("backoff");
    expect(r.timers.filter((t) => !t.cleared).length).toBeGreaterThan(0);
  });

  it("a wipe that closes the database under a running flush is not an error", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((res) => (release = res));
    const { engine } = await started(async (url, init) => {
      await gate;
      return happy()(url, init);
    });
    await engine.addNote(J, "x");
    const running = engine.flush();
    await vi.waitFor(() => expect(engine.getState().status).toBe("syncing"));
    engine.halt();
    release();
    await expect(running).resolves.toBeUndefined();
  });

  it("tells its registry when it halts", async () => {
    const { r, engine } = await started();
    const seen: unknown[] = [];
    r.env.onHalt = (e) => void seen.push(e);
    engine.halt();
    expect(seen).toEqual([engine]);
  });
});

describe("acknowledged work survives a failed refresh", () => {
  const brief = (status: string, statusVersion: number, version: number) => ({ id: J, status, statusVersion, version });

  it("after a sync whose snapshot fetch fails, the job stays on_site with the server's statusVersion, the note stays, and the next status op builds on it", async () => {
    let syncs = 0;
    const { engine, r } = await started((url, init) => {
      if (url === "/api/my/jobs") throw new TypeError("connection lost"); // every refresh fails
      const ops = JSON.parse(String(init?.body)).ops as WireOp[];
      syncs++;
      return reply(200, {
        results: ops.map((o) =>
          o.kind === "note.add"
            ? { opId: o.opId, outcome: "applied", noteId: `server-note-${syncs}`, job: brief("scheduled", 1, 3) }
            : { opId: o.opId, outcome: "applied", job: brief("on_site", 2, 4) },
        ),
        serverTime: "t",
      });
    });
    await engine.addNote(J, "Replaced the cartridge.");
    await engine.setStatus(J, "on_site");
    await engine.flush();
    expect(engine.getState().pending).toBe(0);
    expect(engine.getState().jobs[0]).toMatchObject({ status: "on_site", statusVersion: 2, version: 4 });
    expect(engine.getState().jobs[0].notes.map((n) => [n.id, n.body, n.pending])).toEqual([["server-note-1", "Replaced the cartridge.", undefined]]);
    // The saved copy (what a reload shows) has it too.
    engine.halt();
    const again = await r.open(USER);
    await again.load();
    expect(again.getState().jobs[0]).toMatchObject({ status: "on_site", statusVersion: 2 });
    // Completing offline now works (a note exists) and carries the right base.
    await again.setStatus(J, "completed");
    await again.flush();
    const completed = JSON.parse(String(r.fetch.mock.calls.filter((c) => c[0] === "/api/sync").at(-1)![1]?.body)).ops[0];
    expect(completed).toMatchObject({ to: "completed", baseStatusVersion: 2 });
  });

  it("a refused op's answer still brings the job's real state home", async () => {
    const { engine } = await started((url, init) => {
      if (url === "/api/my/jobs") throw new TypeError("offline");
      const ops = JSON.parse(String(init?.body)).ops as WireOp[];
      return reply(200, { results: ops.map((o) => ({ opId: o.opId, outcome: "conflict", code: "stale_version", job: brief("en_route", 5, 9) })), serverTime: "t" });
    });
    await engine.setStatus(J, "en_route");
    await engine.flush();
    expect(engine.getState().jobs[0]).toMatchObject({ status: "en_route", statusVersion: 5, version: 9 });
    expect(engine.getState().attention).toHaveLength(1);
  });
});

describe("stale refreshes", () => {
  const brief = (status: string, statusVersion: number, version: number) => ({ id: J, status, statusVersion, version });

  it("a GET that read the state before a sync and finishes after it doesn't put the old state back", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((res) => (release = res));
    let gets = 0;
    const pre = { userId: USER, serverTime: "t", jobs: [job()], truncated: false };
    const post = { userId: USER, serverTime: "t2", jobs: [job({ status: "on_site", statusVersion: 2, version: 4 })], truncated: false };
    const { engine } = await started(async (url, init) => {
      if (url === "/api/my/jobs") {
        gets++;
        if (gets === 1) {
          await gate; // the slow request that began before the sync
          return reply(200, pre, { etag: 'W/"pre"' });
        }
        return reply(200, post, { etag: 'W/"post"' });
      }
      const ops = JSON.parse(String(init?.body)).ops as WireOp[];
      return reply(200, { results: ops.map((o) => ({ opId: o.opId, outcome: "applied", job: brief("on_site", 2, 4) })), serverTime: "t" });
    });
    const slow = engine.refresh(); // startup refresh, GET still in flight
    await vi.waitFor(() => expect(gets).toBe(1));
    await engine.setStatus(J, "on_site");
    await engine.flush(); // applies, folds, and refreshes (GET 2: the post-sync state)
    expect(engine.getState().jobs[0]).toMatchObject({ status: "on_site", statusVersion: 2 });
    release();
    await slow;
    expect(engine.getState().pending).toBe(0);
    expect(engine.getState().jobs[0]).toMatchObject({ status: "on_site", statusVersion: 2, version: 4 });
    const next = await engine.setStatus(J, "on_hold").catch((e) => e); // needs a note: the point is the base it would use
    expect(next).toBeInstanceOf(LocalRuleError);
    await engine.addNote(J, "n");
    await engine.setStatus(J, "on_hold");
    const queued = (engine as unknown as { queue: { op: WireOp }[] }).queue.at(-1)!.op as { baseStatusVersion: number };
    expect(queued.baseStatusVersion).toBe(2);
  });
});

describe("overlapping taps", () => {
  it("two status actions that start before the first is stored chain: the second sees the first's version and depends on it", async () => {
    const { engine, r } = await started();
    const [a, b] = await Promise.all([engine.setStatus(J, "en_route"), engine.setStatus(J, "on_site")]);
    expect(engine.getState().pending).toBe(2);
    await engine.flush();
    const [opA, opB] = sentOps(r) as Extract<WireOp, { kind: "status.set" }>[];
    expect(opA).toMatchObject({ opId: a, to: "en_route", baseStatusVersion: 1, dependsOn: null });
    expect(opB).toMatchObject({ opId: b, to: "on_site", baseStatusVersion: 2, dependsOn: a });
  });

  it("a refused intent doesn't block the ones behind it, and notes keep their order", async () => {
    const { engine, r } = await started();
    const results = await Promise.allSettled([engine.setStatus(J, "completed"), engine.addNote(J, "first"), engine.addNote(J, "second"), engine.setStatus(J, "en_route")]);
    expect(results.map((x) => x.status)).toEqual(["rejected", "fulfilled", "fulfilled", "fulfilled"]);
    await engine.flush();
    expect(sentOps(r).map((o) => (o.kind === "note.add" ? o.body : o.to))).toEqual(["first", "second", "en_route"]);
  });
});


describe("the backoff deadline", () => {
  const limited = () => started((url, init) => (url === "/api/sync" ? reply(429, { error: "slow" }, { "retry-after": "120" }) : happy()(url, init)));

  it("automatic flushes (the 60 s tick, the visibility event) stay quiet until the Retry-After deadline; a forced one doesn't", async () => {
    const { engine, r } = await limited();
    await engine.addNote(J, "x");
    await engine.flush();
    expect(syncCalls(r)).toBe(1);
    r.clock.t += 60_000;
    await engine.flush();
    expect(syncCalls(r)).toBe(1);
    r.clock.t += 61_000;
    await engine.flush();
    expect(syncCalls(r)).toBe(2);
    await engine.flush({ force: true });
    expect(syncCalls(r)).toBe(3);
  });

  it("work queued during a backoff doesn't pull the retry forward", async () => {
    const { engine, r } = await limited();
    await engine.addNote(J, "x");
    await engine.flush();
    const deadline = engine.getState().nextRetryAt!;
    await engine.addNote(J, "y");
    const live = r.timers.filter((t) => !t.cleared).at(-1)!;
    expect(r.clock.t + live.ms).toBeGreaterThanOrEqual(deadline);
  });

  it("coming back online ends a network-error backoff at once, but not a 429's", async () => {
    let offline = true;
    const { engine, r } = await started((url, init) => {
      if (offline) throw new TypeError("offline");
      return happy()(url, init);
    });
    await engine.addNote(J, "x");
    await engine.flush();
    expect(engine.getState().status).toBe("backoff");
    offline = false;
    await engine.connectivityRestored();
    expect(engine.getState().pending).toBe(0);

    const limitedRig = await limited();
    await limitedRig.engine.addNote(J, "x");
    await limitedRig.engine.flush();
    await limitedRig.engine.connectivityRestored();
    expect(syncCalls(limitedRig.r)).toBe(1);
    void r;
  });
});
