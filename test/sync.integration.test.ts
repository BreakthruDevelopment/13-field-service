/**
 * The offline sync (13.2) against a real Postgres (TEST_DATABASE_URL): exactly-once ops through the (actor, op id) ledger,
 * per-op outcomes, status_version and dependsOn conflicts, reassigned and cancelled jobs, caps, the time budget, rate
 * limits, the snapshot's scope, and parallel batches racing the dispatcher without a deadlock.
 */
process.env.DB_POOL_MAX = "2"; // the AWS setting; the race tests must pass on a pool this small
process.env.LOG_LEVEL = "warn";

import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clean, setup, testDatabaseUrl, uuid, window, type TestUser } from "./fs-helpers";

const P = "syn";

type Op = Record<string, unknown> & { opId: string };

describe.skipIf(!testDatabaseUrl)("offline sync (Postgres)", () => {
  let sql: postgres.Sql;
  let d1: TestUser, t1: TestUser, t2: TestUser, t3: TestUser, t4: TestUser, plain: TestUser, admin: TestUser;
  let S: typeof import("@/lib/sync");
  let snap: typeof import("@/lib/tech-snapshot");
  let jobs: typeof import("@/lib/service-jobs");
  let customers: typeof import("@/lib/customers");
  let adminLib: typeof import("@/lib/admin");
  let maintenance: typeof import("@/lib/maintenance");
  let errorInfo: typeof import("@/lib/http").errorInfo;
  let customerId: string, siteId: string;

  const newJob = async (tech: TestUser | null = t1, extra: Record<string, unknown> = {}) =>
    (await jobs.createJob(d1, { customerId, siteId, title: "Job", ...(tech ? { assigneeId: tech.id, ...window() } : {}), ...extra })).job;
  const at = () => new Date().toISOString();
  const note = (jobId: string, body = "did the thing", extra: Record<string, unknown> = {}): Op => ({ kind: "note.add", opId: uuid(), jobId, clientAt: at(), body, ...extra });
  const status = (jobId: string, to: string, base: number, extra: Record<string, unknown> = {}): Op => ({
    kind: "status.set",
    opId: uuid(),
    jobId,
    clientAt: at(),
    to,
    baseStatusVersion: base,
    dependsOn: null,
    ...extra,
  });
  const run = (who: TestUser, ops: Op[], opts?: Parameters<typeof S.syncBatch>[2]) => S.syncBatch(who, { ownerId: who.id, ops }, opts);
  const dispatcherUpdate = async (jobId: string, patch: Record<string, unknown>) => {
    const j = await jobs.getJob(d1, jobId);
    return jobs.updateJob(d1, jobId, { version: j.version, ...patch });
  };
  const rows = async (q: ReturnType<typeof sql>) => (await q) as unknown as Record<string, unknown>[];
  const count = async (table: "job_note" | "job_event", jobId: string) =>
    (await rows(sql`select count(*)::int as n from ${sql(table)} where job_id = ${jobId}`))[0].n as number;

  beforeAll(async () => {
    const s = await setup(P, { d1: "dispatcher", t1: "technician", t2: "technician", t3: "technician", t4: "technician", plain: "user", admin: "admin" });
    sql = s.sql;
    ({ d1, t1, t2, t3, t4, plain, admin } = s.users);
    S = await import("@/lib/sync");
    snap = await import("@/lib/tech-snapshot");
    jobs = await import("@/lib/service-jobs");
    customers = await import("@/lib/customers");
    adminLib = await import("@/lib/admin");
    maintenance = await import("@/lib/maintenance");
    ({ errorInfo } = await import("@/lib/http"));
    customerId = (await customers.createCustomer(d1, { name: "Acme", phone: "555-0100", email: "boss@acme.example", notes: "Gate code 1234" })).customer.id;
    siteId = (await customers.createSite(d1, customerId, { label: "Main", address: "1 Main St", accessNotes: "Side door", lat: 30.2672, lng: -97.7431 })).site.id;
  });

  beforeEach(async () => {
    await sql`delete from rate_event where user_id like ${`${P}-%`}`;
  });

  afterAll(async () => {
    await clean(sql, P);
    await sql.end();
  });

  describe("exactly once", () => {
    it("replaying a whole batch returns the same results: one note, one event, nothing charged twice", async () => {
      const job = await newJob();
      const batch = [note(job.id, "Replaced the cartridge."), status(job.id, "en_route", job.statusVersion), status(job.id, "on_site", job.statusVersion + 1, { dependsOn: null })];
      batch[2].dependsOn = batch[1].opId;
      const first = await run(t1, batch);
      expect(first.results.map((r) => r.outcome)).toEqual(["applied", "applied", "applied"]);
      expect(first.results[2].job).toMatchObject({ status: "on_site", statusVersion: job.statusVersion + 2 });

      const second = await run(t1, batch);
      expect(second.results.map((r) => ({ opId: r.opId, outcome: r.outcome }))).toEqual(batch.map((o) => ({ opId: o.opId, outcome: "replayed" })));
      expect(second.results.map((r) => ({ ...r, outcome: "applied" }))).toEqual(first.results);
      expect(await count("job_note", job.id)).toBe(1);
      // created + assigned + 2 status events
      expect(await count("job_event", job.id)).toBe(4);
      // A pure replay refunds its flush: two requests, one unit spent.
      expect((await rows(sql`select count(*)::int as n from rate_event where user_id = ${t1.id} and kind = 'sync'`))[0].n).toBe(1);
    });

    it("the same op id with a different payload or kind is op_id_reused and changes nothing", async () => {
      const job = await newJob();
      const n = note(job.id, "first");
      await run(t1, [n]);
      const other = await run(t1, [{ ...n, body: "second" }]);
      expect(other.results[0]).toEqual({ opId: n.opId, outcome: "rejected", code: "op_id_reused" });
      const asStatus = await run(t1, [status(job.id, "en_route", job.statusVersion, { opId: n.opId })]);
      expect(asStatus.results[0]).toMatchObject({ outcome: "rejected", code: "op_id_reused" });
      const bodies = await rows(sql`select body from job_note where job_id = ${job.id}`);
      expect(bodies).toEqual([{ body: "first" }]);
      expect((await jobs.getJob(d1, job.id)).status).toBe("scheduled");
    });

    it("a note whose op id was already used through the online notes route is not added twice", async () => {
      const job = await newJob();
      const n = note(job.id, "typed online first");
      await jobs.addJobNote(t1, job.id, { body: "typed online first", opId: n.opId });
      const res = await run(t1, [n]);
      expect(res.results[0].outcome).toBe("applied");
      expect(await count("job_note", job.id)).toBe(1);
    });

    it("op ids are per technician: another technician can't read or collide with someone's ledger row", async () => {
      const job = await newJob(t1);
      const mine = await newJob(t2);
      const n = note(job.id, "t1 note");
      await run(t1, [n]);
      const res = await run(t2, [{ ...n, jobId: mine.id }]);
      expect(res.results[0].outcome).toBe("applied"); // t2's own ledger row, t2's own job
      expect(await count("job_note", mine.id)).toBe(1);
      expect(await count("job_note", job.id)).toBe(1);
    });
  });

  describe("conflicts and refusals", () => {
    it("a stale baseStatusVersion is a conflict that carries the server's state, and changes nothing", async () => {
      const job = await newJob();
      await dispatcherUpdate(job.id, { op: "status", to: "en_route" }); // the office moved it: statusVersion + 1
      const res = await run(t1, [status(job.id, "en_route", job.statusVersion)]);
      expect(res.results[0]).toMatchObject({ outcome: "conflict", code: "stale_version", job: { status: "en_route", statusVersion: job.statusVersion + 1 } });
      expect(await count("job_event", job.id)).toBe(3); // created, assigned, the dispatcher's status
    });

    it("a reschedule alone doesn't invalidate a queued status change", async () => {
      const job = await newJob();
      await dispatcherUpdate(job.id, { op: "reschedule", ...window(5, 2) });
      const res = await run(t1, [status(job.id, "en_route", job.statusVersion)]);
      expect(res.results[0]).toMatchObject({ outcome: "applied", job: { status: "en_route" } });
    });

    it("after a reassignment the old technician's note is rejected not_assigned (nothing stored) and a status op is a conflict", async () => {
      const job = await newJob(t1);
      await dispatcherUpdate(job.id, { op: "assign", assigneeId: t2.id });
      const res = await run(t1, [note(job.id, "text that must stay on the phone"), status(job.id, "en_route", job.statusVersion)]);
      expect(res.results[0]).toEqual({ opId: expect.any(String), outcome: "rejected", code: "not_assigned" });
      expect(res.results[1]).toEqual({ opId: expect.any(String), outcome: "conflict", code: "not_assigned" });
      expect(await count("job_note", job.id)).toBe(0);
      expect(JSON.stringify(res)).not.toContain("t2");
    });

    it("dependsOn on a conflicted op is a conflict even when the version number happens to match", async () => {
      const job = await newJob();
      const a = status(job.id, "en_route", job.statusVersion);
      const b = status(job.id, "on_site", job.statusVersion + 1, { dependsOn: a.opId });
      await dispatcherUpdate(job.id, { op: "status", to: "en_route" }); // statusVersion is now exactly what b expects
      const res = await run(t1, [a, b]);
      expect(res.results[0]).toMatchObject({ outcome: "conflict", code: "stale_version" });
      expect(res.results[1]).toMatchObject({ outcome: "conflict", code: "dependency_unmet" });
      expect((await jobs.getJob(d1, job.id)).status).toBe("en_route"); // still the dispatcher's state
      expect(await count("job_event", job.id)).toBe(3);
    });

    it("dependsOn must name an applied status op on the same job (not itself, not a note, not another job, not nothing)", async () => {
      const job = await newJob();
      const other = await newJob();
      const n = note(job.id);
      const otherStatus = status(other.id, "en_route", other.statusVersion);
      await run(t1, [n, otherStatus]);
      const self = status(job.id, "en_route", job.statusVersion);
      self.dependsOn = self.opId;
      const results = (
        await run(t1, [
          self,
          status(job.id, "en_route", job.statusVersion, { dependsOn: n.opId }),
          status(job.id, "en_route", job.statusVersion, { dependsOn: otherStatus.opId }),
          status(job.id, "en_route", job.statusVersion, { dependsOn: uuid() }),
        ])
      ).results;
      expect(results.map((r) => [r.outcome, r.code])).toEqual(Array(4).fill(["conflict", "dependency_unmet"]));
    });

    it("completing needs a note on the job (rejected), and a note earlier in the same batch counts", async () => {
      const job = await newJob();
      const on = status(job.id, "on_site", job.statusVersion);
      const done = status(job.id, "completed", job.statusVersion + 1, { dependsOn: on.opId });
      const res = await run(t1, [on, done]);
      expect(res.results[1]).toMatchObject({ outcome: "rejected", code: "note_required", job: { status: "on_site" } });

      const done2 = status(job.id, "completed", job.statusVersion + 1, { dependsOn: on.opId });
      const res2 = await run(t1, [note(job.id, "all done"), done2]);
      expect(res2.results.map((r) => r.outcome)).toEqual(["applied", "applied"]);
      expect((await jobs.getJob(d1, job.id)).status).toBe("completed");
    });

    it("a transition the status machine refuses is a conflict with the rule's code", async () => {
      const job = await newJob();
      const res = await run(t1, [status(job.id, "completed", job.statusVersion), status(job.id, "scheduled", job.statusVersion)]);
      expect(res.results.map((r) => [r.outcome, r.code])).toEqual([
        ["conflict", "transition_not_allowed"],
        ["conflict", "transition_not_allowed"],
      ]);
    });

    it("a cancelled job refuses a technician's note (rejected) and status (conflict), and a completed job still takes a late note", async () => {
      const job = await newJob();
      await dispatcherUpdate(job.id, { op: "cancel" });
      const res = await run(t1, [note(job.id), status(job.id, "en_route", job.statusVersion + 1)]);
      expect(res.results.map((r) => [r.outcome, r.code])).toEqual([
        ["rejected", "job_cancelled"],
        ["conflict", "job_cancelled"],
      ]);
      expect(await count("job_note", job.id)).toBe(0);

      const finished = await newJob();
      await run(t1, [note(finished.id), status(finished.id, "on_site", finished.statusVersion)]);
      await run(t1, [status(finished.id, "completed", finished.statusVersion + 1)]);
      const late = await run(t1, [note(finished.id, "forgot to say: left the ladder")]);
      expect(late.results[0].outcome).toBe("applied");
    });

    it("another technician's job and a made-up job answer the same: not_assigned, with no job data", async () => {
      const theirs = await newJob(t2);
      const res = await run(t1, [note(theirs.id), note(uuid()), status(theirs.id, "en_route", 1), status(uuid(), "en_route", 1)]);
      const strip = (r: { opId: string }) => ({ ...r, opId: undefined });
      expect(res.results.map(strip)).toEqual([
        { outcome: "rejected", code: "not_assigned" },
        { outcome: "rejected", code: "not_assigned" },
        { outcome: "conflict", code: "not_assigned" },
        { outcome: "conflict", code: "not_assigned" },
      ]);
      expect(await count("job_note", theirs.id)).toBe(0);
      expect((await jobs.getJob(d1, theirs.id)).status).toBe("scheduled");
    });

    it("a technician's 200th note is the last; the 201st is rejected note_limit and the batch carries on", async () => {
      const job = await newJob();
      await sql`insert into job_note (job_id, author_id, body) select ${job.id}, ${t1.id}, 'n' from generate_series(1, 199)`;
      const res = await run(t1, [note(job.id, "200"), note(job.id, "201"), status(job.id, "en_route", job.statusVersion)]);
      expect(res.results.map((r) => [r.outcome, r.code])).toEqual([["applied", undefined], ["rejected", "note_limit"], ["applied", undefined]]);
      expect(await count("job_note", job.id)).toBe(200);
    });

    it("a refused op is stored: replaying it returns the same refusal even after the job changes", async () => {
      const job = await newJob();
      await dispatcherUpdate(job.id, { op: "status", to: "en_route" });
      const op = status(job.id, "en_route", job.statusVersion);
      const first = await run(t1, [op]);
      expect(first.results[0].outcome).toBe("conflict");
      const again = await run(t1, [op]);
      expect(again.results[0]).toMatchObject({ outcome: "conflict", code: "stale_version", replayed: true });
    });
  });

  describe("check-in location", () => {
    it("is stored to 4 decimals with the device clock clamped, only on a move to on_site", async () => {
      const job = await newJob();
      const capturedAt = new Date(Date.now() - 3600_000).toISOString();
      const res = await run(t1, [
        status(job.id, "on_site", job.statusVersion, { location: { lat: 30.26721999, lng: -97.74309999, accuracyM: 24.6, capturedAt } }),
      ]);
      expect(res.results[0].outcome).toBe("applied");
      const [ev] = await rows(sql`select lat, lng, accuracy_m, late, captured_at from job_event where job_id = ${job.id} and to_status = 'on_site'`);
      expect(ev).toMatchObject({ lat: "30.2672", lng: "-97.7431", accuracy_m: 25, late: true });
      // The coordinates are purged with the rest of the location data 90 days after completion.
      await sql`update service_job set status = 'completed', completed_at = now() - interval '91 days' where id = ${job.id}`;
      await maintenance.purgeStaleLocations();
      expect((await rows(sql`select lat, lng from job_event where job_id = ${job.id} and to_status = 'on_site'`))[0]).toEqual({ lat: null, lng: null });
    });

    it("a location on any other move is an invalid op (rejected, never stored), and bad coordinates too", async () => {
      const job = await newJob();
      const loc = { lat: 30, lng: -97, accuracyM: 5, capturedAt: at() };
      const res = await run(t1, [
        status(job.id, "en_route", job.statusVersion, { location: loc }),
        status(job.id, "on_site", job.statusVersion, { location: { ...loc, lat: 91 } }),
        status(job.id, "on_site", job.statusVersion, { location: { ...loc, accuracyM: 10_001 } }),
        status(job.id, "on_site", job.statusVersion, { location: { ...loc, extra: 1 } }),
      ]);
      expect(res.results.map((r) => [r.outcome, r.code])).toEqual(Array(4).fill(["rejected", "invalid_op"]));
      expect((await jobs.getJob(d1, job.id)).status).toBe("scheduled");
      expect((await rows(sql`select count(*)::int as n from sync_op where actor_id = ${t1.id} and job_id = ${job.id}`))[0].n).toBe(0);
    });
  });

  describe("input hygiene", () => {
    it("rejects the whole request for a NUL byte, a malformed envelope, a duplicate op id, or more than 50 ops", async () => {
      const job = await newJob();
      const bad = async (body: unknown) => {
        try {
          await S.syncBatch(t1, body);
        } catch (err) {
          return errorInfo(err).status;
        }
        return 200;
      };
      expect(await bad({ ownerId: t1.id, ops: [note(job.id, "nul\0byte")] })).toBe(400);
      expect(await bad({ ownerId: t1.id, deviceId: "d\0", ops: [note(job.id)] })).toBe(400);
      expect(await bad({ ownerId: t1.id, ops: [] })).toBe(400);
      expect(await bad({ ownerId: t1.id })).toBe(400);
      expect(await bad({ ownerId: t1.id, ops: [{ kind: "note.add" }] })).toBe(400); // no op id
      expect(await bad({ ownerId: t1.id, ops: [note(job.id)], extra: 1 })).toBe(400);
      const dup = note(job.id);
      expect(await bad({ ownerId: t1.id, ops: [dup, dup] })).toBe(400);
      expect(await bad({ ownerId: t1.id, ops: Array.from({ length: 51 }, () => note(job.id)) })).toBe(400);
      expect(await bad({ ops: [note(job.id)] })).toBe(400); // no owner
      expect(await count("job_note", job.id)).toBe(0);
      // ...and none of those cost a flush.
      expect((await rows(sql`select count(*)::int as n from rate_event where user_id = ${t1.id} and kind = 'sync'`))[0].n).toBe(0);
    });

    it("an invalid op (long text, unknown kind, extra field, empty note) is rejected on its own and the rest of the batch runs", async () => {
      const job = await newJob();
      const res = await run(t1, [
        note(job.id, "x".repeat(2001)),
        { kind: "photo.add", opId: uuid(), jobId: job.id },
        note(job.id, "ok", { extra: true }),
        note(job.id, "   "),
        note(job.id, "a fine note"),
        { ...note(job.id), jobId: "not-a-uuid" },
        status(job.id, "en_route", 0),
        status(job.id, "en_route", job.statusVersion),
      ]);
      expect(res.results.map((r) => r.outcome)).toEqual(["rejected", "rejected", "rejected", "rejected", "applied", "rejected", "rejected", "applied"]);
      expect(res.results.filter((r) => r.outcome === "rejected").every((r) => r.code === "invalid_op")).toBe(true);
      expect(await count("job_note", job.id)).toBe(1);
    });

    it("a 2,000-character note with a 60-character unbroken word is stored as sent", async () => {
      const job = await newJob();
      const body = `${"w".repeat(60)} ${"é".repeat(1900)}`;
      expect((await run(t1, [note(job.id, body)])).results[0].outcome).toBe("applied");
      expect((await rows(sql`select body from job_note where job_id = ${job.id}`))[0].body).toBe(body);
    });
  });

  describe("access", () => {
    it("only a technician may sync: a dispatcher, an admin and a plain user get 403, and nothing is written", async () => {
      const job = await newJob();
      for (const who of [d1, admin, plain]) {
        await expect(S.syncBatch(who, { ownerId: who.id, ops: [note(job.id)] })).rejects.toMatchObject({ status: 403 });
      }
      await expect(snap.getTechSnapshot(d1)).rejects.toMatchObject({ status: 403 });
      await expect(snap.getTechSnapshot(admin)).rejects.toMatchObject({ status: 403 });
      expect(await count("job_note", job.id)).toBe(0);
    });

    it("a batch from a device whose saved data belongs to another account is a 409 owner_mismatch, processed nowhere, charged nothing", async () => {
      const job = await newJob(t1);
      await expect(S.syncBatch(t1, { ownerId: t2.id, ops: [note(job.id)] })).rejects.toMatchObject({ status: 409, code: "owner_mismatch" });
      expect(await count("job_note", job.id)).toBe(0);
      expect((await rows(sql`select count(*)::int as n from rate_event where user_id = ${t1.id}`))[0].n).toBe(0);
    });

    it("a technician whose role was revoked since the session was issued gets 403 and nothing is applied", async () => {
      const job = await newJob(t3);
      await sql`update "user" set role = 'user' where id = ${t3.id}`;
      try {
        await expect(run(t3, [note(job.id)])).rejects.toMatchObject({ status: 403 });
        expect(await count("job_note", job.id)).toBe(0);
      } finally {
        await sql`update "user" set role = 'technician' where id = ${t3.id}`;
      }
    });
  });

  describe("budget and rate", () => {
    it("past the time budget the rest is deferred (never half-applied), and a resend applies it", async () => {
      const job = await newJob();
      const ops = [note(job.id, "one"), note(job.id, "two"), note(job.id, "three")];
      const ticks = [0, 0, 9000, 9000, 9000, 9000]; // started, op 1 ok, op 2 over budget
      let i = 0;
      const clock = () => ticks[Math.min(i++, ticks.length - 1)];
      const first = await run(t1, ops, { clock, budgetMs: 8000 });
      expect(first.results.map((r) => r.outcome)).toEqual(["applied", "deferred", "deferred"]);
      expect(await count("job_note", job.id)).toBe(1);
      const second = await run(t1, ops);
      expect(second.results.map((r) => r.outcome)).toEqual(["replayed", "applied", "applied"]);
      expect((await rows(sql`select body from job_note where job_id = ${job.id} order by server_at`)).map((r) => r.body)).toEqual(["one", "two", "three"]);
    });

    it("a fully deferred request costs no flush", async () => {
      const job = await newJob();
      const res = await run(t1, [note(job.id)], { budgetMs: 0 });
      expect(res.results[0].outcome).toBe("deferred");
      expect((await rows(sql`select count(*)::int as n from rate_event where user_id = ${t1.id} and kind = 'sync'`))[0].n).toBe(0);
    });

    it("an op that waits on a locked job more than the lock timeout is deferred along with everything after it", async () => {
      const job = await newJob();
      const other = await newJob();
      const held = sql.begin(async (tx) => {
        await tx`select id from service_job where id = ${job.id} for update`;
        await new Promise((r) => setTimeout(r, S.SYNC_LOCK_TIMEOUT_MS + 1500));
      });
      await new Promise((r) => setTimeout(r, 200));
      const res = await run(t1, [note(job.id, "blocked"), note(other.id, "must wait its turn")]);
      expect(res.results.map((r) => r.outcome)).toEqual(["deferred", "deferred"]);
      await held;
      expect((await run(t1, [note(job.id, "blocked"), note(other.id, "must wait its turn")])).results.map((r) => r.outcome)).toEqual(["applied", "applied"]);
    }, 15_000);

    it("30 flushes an hour: the 31st is a 429 and nothing in it is processed; pure replays are free", async () => {
      const job = await newJob(t2);
      for (let i = 0; i < 30; i++) await run(t2, [note(job.id, `n${i}`)]);
      const op = note(job.id, "too many");
      await expect(run(t2, [op])).rejects.toMatchObject({ status: 429 });
      expect(await count("job_note", job.id)).toBe(30);
      await sql`delete from rate_event where user_id = ${t2.id}`;
      const batch = [note(job.id, "once")];
      await run(t2, batch);
      for (let i = 0; i < 40; i++) expect((await run(t2, batch)).results[0].outcome).toBe("replayed");
      expect(await count("job_note", job.id)).toBe(31);
    }, 60_000);
  });

  describe("races", () => {
    it("the same batch sent six times at once applies each op exactly once", async () => {
      const job = await newJob();
      const a = status(job.id, "en_route", job.statusVersion);
      const batch = [note(job.id, "racing"), a, status(job.id, "on_site", job.statusVersion + 1, { dependsOn: a.opId })];
      const results = await Promise.all(Array.from({ length: 6 }, () => run(t1, batch)));
      for (let i = 0; i < batch.length; i++) {
        const outcomes = results.map((r) => r.results[i].outcome);
        expect(outcomes.filter((o) => o === "applied")).toHaveLength(1);
        expect(outcomes.filter((o) => o === "replayed")).toHaveLength(5);
      }
      expect(await count("job_note", job.id)).toBe(1);
      expect(await count("job_event", job.id)).toBe(4);
      expect((await jobs.getJob(d1, job.id)).status).toBe("on_site");
    });

    it("parallel batches racing the dispatcher's reschedules, reassignments and cancels, and an admin role flip, never deadlock", async () => {
      const shared = await newJob(t1);
      const mine = await Promise.all([newJob(t1), newJob(t1)]);
      const tasks: Promise<unknown>[] = [];
      for (let round = 0; round < 6; round++) {
        const targets = [shared, ...mine];
        for (const j of targets) {
          tasks.push(run(t1, [note(j.id, `r${round}`), status(j.id, "en_route", 1), note(j.id, `r${round}b`)]));
          tasks.push(run(t1, [status(j.id, "on_site", 2), note(j.id, `r${round}c`)]));
        }
        tasks.push(dispatcherUpdate(shared.id, { op: "reschedule", ...window(3 + round, 2) }));
        tasks.push(dispatcherUpdate(shared.id, round % 2 ? { op: "assign", assigneeId: t1.id } : { op: "assign", assigneeId: t2.id }));
        tasks.push(dispatcherUpdate(mine[0].id, { op: "reschedule", ...window(4 + round, 1) }));
        if (round === 3) tasks.push(adminLib.setUserRole(admin, { userId: t2.id, role: "technician", from: "technician", clientOpId: uuid() }).catch(() => undefined));
        tasks.push(dispatcherUpdate(mine[1].id, { op: "cancel" }));
      }
      const settled = await Promise.allSettled(tasks);
      const failures = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected").map((s) => errorInfo(s.reason));
      // Version conflicts and refused moves are normal; a deadlock (code "retry") or a 500 never is.
      for (const f of failures) {
        expect(f.status, JSON.stringify(f.body)).toBeLessThan(500);
        expect(f.body.code).not.toBe("retry");
      }
      // Whatever interleaving happened, a note is in the database at most once per op.
      expect((await rows(sql`select count(*)::int as n from (select op_id from job_note where author_id = ${t1.id} and op_id is not null group by op_id having count(*) > 1) d`))[0].n).toBe(0);
    }, 60_000);
  });

  describe("GET /api/my/jobs snapshot", () => {
    it("holds the technician's own jobs with customer name and phone, access notes and the last 20 notes, and nothing private", async () => {
      const job = await newJob(t4);
      await newJob(t2); // someone else's
      await sql`insert into job_note (job_id, author_id, body, server_at) select ${job.id}, ${d1.id}, 'office ' || g, now() - make_interval(mins => 100 - g) from generate_series(1, 25) g`;
      await run(t4, [note(job.id, "mine")]);
      const { snapshot } = await snap.getTechSnapshot(t4);
      expect(snapshot.userId).toBe(t4.id);
      expect(snapshot.jobs.map((j) => j.id)).toEqual([job.id]);
      const j = snapshot.jobs[0];
      expect(j).toMatchObject({ customer: { name: "Acme", phone: "555-0100" }, site: { address: "1 Main St", accessNotes: "Side door", lat: 30.2672, lng: -97.7431 }, statusVersion: job.statusVersion, notesTruncated: true });
      expect(j.notes).toHaveLength(20);
      expect(j.notes.at(-1)).toMatchObject({ body: "mine", byMe: true });
      expect(j.notes[0].byMe).toBe(false);
      const text = JSON.stringify(snapshot);
      for (const secret of ["boss@acme.example", "Gate code", t2.id, d1.id, "email"]) expect(text).not.toContain(secret);
    });

    it("includes open jobs within 14 days, anything under way, recent completions and cancellations; leaves out the rest", async () => {
      const mk = async (title: string, set: string) => {
        const j = await newJob(t3, { title });
        await sql.unsafe(`update service_job set ${set} where id = '${j.id}'`);
        return j.id;
      };
      const soon = await mk("soon", "scheduled_start = now() + interval '2 days', scheduled_end = now() + interval '2 days 1 hour'");
      const far = await mk("far", "scheduled_start = now() + interval '20 days', scheduled_end = now() + interval '20 days 1 hour'");
      const underway = await mk("underway", "status = 'on_site', scheduled_start = now() + interval '30 days', scheduled_end = now() + interval '30 days 1 hour'");
      const doneNew = await mk("done-new", "status = 'completed', completed_at = now() - interval '2 days'");
      const doneOld = await mk("done-old", "status = 'completed', completed_at = now() - interval '4 days'");
      const cancelledNew = await mk("cancel-new", "status = 'cancelled', updated_at = now() - interval '1 day'");
      const cancelledOld = await mk("cancel-old", "status = 'cancelled', updated_at = now() - interval '5 days'");
      const ids = (await snap.loadTechSnapshot(t3)).jobs.map((j) => j.id);
      for (const id of [soon, underway, doneNew, cancelledNew]) expect(ids).toContain(id);
      for (const id of [far, doneOld, cancelledOld]) expect(ids).not.toContain(id);
    });

    it("has a stable ETag per user and content, and a different one once something changes", async () => {
      const a = await snap.getTechSnapshot(t2);
      const b = await snap.getTechSnapshot(t2);
      expect(a.etag).toBe(b.etag);
      expect(a.etag).not.toBe((await snap.getTechSnapshot(t3)).etag);
      const job = (await snap.loadTechSnapshot(t2)).jobs[0];
      await run(t2, [note(job.id, "changes the etag")]);
      expect((await snap.getTechSnapshot(t2)).etag).not.toBe(a.etag);
    });

    it("120 reads an hour, then a 429", async () => {
      await sql`insert into rate_event (user_id, kind) select ${t3.id}, 'snapshot' from generate_series(1, 120)`;
      await expect(snap.getTechSnapshot(t3)).rejects.toMatchObject({ status: 429 });
    });

    it("says truncated when more than 50 jobs match, even though the 50 sent fit the byte budget", async () => {
      const t = t2;
      await sql`delete from service_job where assignee_id = ${t.id}`;
      for (let i = 0; i < 51; i++) await newJob(t, { title: `bulk ${i}` });
      const snapshot = await snap.loadTechSnapshot(t);
      expect(snapshot.jobs).toHaveLength(50);
      expect(snapshot.truncated).toBe(true);
      await sql`delete from service_job where id = ${snapshot.jobs[0].id}`;
      expect((await snap.loadTechSnapshot(t)).truncated).toBe(false);
    }, 30_000);

    it("fitSnapshot keeps the body under the limit: later jobs go first, then older notes", () => {
      const note_ = (i: number) => ({ id: String(i), body: "x".repeat(1000), clientAt: null, serverAt: "2026-01-01T00:00:00.000Z", byMe: true });
      const job = (i: number) =>
        ({
          id: `j${i}`, number: i, title: "t", description: "d".repeat(5000), priority: "normal", status: "scheduled", version: 1, statusVersion: 1,
          scheduledStart: null, scheduledEnd: null, completedAt: null, customer: { name: "n", phone: "p" },
          site: { label: "l", address: "a", accessNotes: "", lat: null, lng: null }, notes: Array.from({ length: 20 }, (_, k) => note_(k)), notesTruncated: false,
        }) as import("@/lib/tech-snapshot").TechJob;
      const fit = snap.fitSnapshot(Array.from({ length: 50 }, (_, i) => job(i)), 100_000);
      expect(Buffer.byteLength(JSON.stringify({ jobs: fit.jobs }))).toBeLessThanOrEqual(100_000);
      expect(fit.truncated).toBe(true);
      expect(fit.jobs[0].notesTruncated).toBe(true);
      const roomy = snap.fitSnapshot([job(1), job(2)], 1_000_000);
      expect(roomy).toMatchObject({ truncated: false });
      expect(roomy.jobs.every((j) => j.notes.length === 20 && !j.notesTruncated)).toBe(true);
    });
  });
});
