/** Edge cases found in review of 13.1: NUL in ids, coordinates, reopen and assignment vs role revocation, time zones, closed jobs, check-in visibility, clock clamps. */
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clean, setup, testDatabaseUrl, uuid, window, type TestUser } from "./fs-helpers";

const P = "rfx";

describe.skipIf(!testDatabaseUrl)("review fixes (Postgres)", () => {
  let sql: postgres.Sql;
  let d1: TestUser, t1: TestUser, t2: TestUser, admin: TestUser;
  let jobs: typeof import("@/lib/service-jobs");
  let customers: typeof import("@/lib/customers");
  let board: typeof import("@/lib/board");
  let adminLib: typeof import("@/lib/admin");
  let errorInfo: typeof import("@/lib/http").errorInfo;
  let customerId: string, siteId: string;

  const status = (p: Promise<unknown>) => p.then(() => 200, (e: unknown) => errorInfo(e).status);
  const newJob = async (extra: Record<string, unknown> = {}) => (await jobs.createJob(d1, { customerId, siteId, title: "Job", ...extra })).job;
  const assigned = (tech: TestUser) => newJob({ assigneeId: tech.id, ...window() });

  beforeAll(async () => {
    const s = await setup(P, { d1: "dispatcher", t1: "technician", t2: "technician", admin: "admin" });
    sql = s.sql;
    ({ d1, t1, t2, admin } = s.users);
    jobs = await import("@/lib/service-jobs");
    customers = await import("@/lib/customers");
    board = await import("@/lib/board");
    adminLib = await import("@/lib/admin");
    ({ errorInfo } = await import("@/lib/http"));
    customerId = (await customers.createCustomer(d1, { name: "Co", phone: "1" })).customer.id;
    siteId = (await customers.createSite(d1, customerId, { label: "S", address: "A", lat: 30.1, lng: -97.1 })).site.id;
  });
  afterAll(async () => {
    await clean(sql, P);
    await sql.end();
  });

  it("a NUL byte in any id field is a 400, not a database error", async () => {
    const job = await assigned(t1);
    const nul = "t\0x";
    expect(await status(jobs.createJob(d1, { customerId, siteId, title: "x", assigneeId: nul, ...window() }))).toBe(400);
    expect(await status(jobs.updateJob(d1, job.id, { op: "assign", version: job.version, assigneeId: nul }))).toBe(400);
    expect(await status(jobs.listJobs(d1, { assigneeId: nul }))).toBe(400);
    expect(await status(adminLib.setUserRole(admin, { userId: nul, role: "user" }))).toBe(400);
    expect(await status(jobs.getJob(d1, nul))).toBe(400);
    expect(await status(jobs.listJobs(d1, { customerId: nul }))).toBe(400);
    expect(await status(customers.getCustomer(d1, nul))).toBe(400);
    expect(await status(board.getBoard(d1, { date: "2031-03-10", tz: nul }))).toBe(400);
  });

  it("clearing one site coordinate clears both instead of failing", async () => {
    const s = (await customers.createSite(d1, customerId, { label: "Geo", address: "G", lat: 10, lng: 20 })).site;
    const a = await customers.updateSite(d1, s.id, { version: s.version, lat: null });
    expect(a).toMatchObject({ lat: null, lng: null });
    const b = await customers.updateSite(d1, s.id, { version: a.version, lat: 11, lng: 21 });
    expect(b).toMatchObject({ lat: 11, lng: 21 });
    const c = await customers.updateSite(d1, s.id, { version: b.version, lng: null });
    expect(c).toMatchObject({ lat: null, lng: null });
    expect(await status(customers.updateSite(d1, s.id, { version: c.version, lat: 5 }))).toBe(400);
    expect(await status(customers.updateSite(d1, s.id, { version: c.version, lat: null, lng: 5 }))).toBe(400);
  });

  it("reopening gives a job whose technician lost the role back to the tray", async () => {
    const tech = (await sql`insert into "user" (id, name, email, role) values (${`${P}-t3`}, 't3', ${`${P}-t3@test.local`}, 'technician') returning id`)[0].id as string;
    const job = await newJob({ assigneeId: tech, ...window() });
    let v = (await jobs.updateJob(d1, job.id, { op: "status", version: job.version, to: "on_site" })).version;
    await jobs.addJobNote(d1, job.id, { body: "done" });
    v = (await jobs.getJob(d1, job.id)).version;
    const done = await jobs.updateJob(d1, job.id, { op: "status", version: v, to: "completed" });
    await sql`update "user" set role = 'user' where id = ${tech}`;
    const reopened = await jobs.updateJob(d1, job.id, { op: "reopen", version: done.version });
    expect(reopened).toMatchObject({ status: "unassigned", assignee: null, completedAt: null });
    expect(reopened.events.at(-1)).toMatchObject({ kind: "unassigned", toStatus: "unassigned" });
    // And a still-valid technician keeps the job.
    const j2 = await assigned(t1);
    const on = await jobs.updateJob(d1, j2.id, { op: "status", version: j2.version, to: "on_site" });
    await jobs.addJobNote(d1, j2.id, { body: "held" });
    const hold = await jobs.updateJob(d1, j2.id, { op: "status", version: (await jobs.getJob(d1, j2.id)).version, to: "on_hold" });
    expect(on.status).toBe("on_site");
    expect(await jobs.updateJob(d1, j2.id, { op: "reopen", version: hold.version })).toMatchObject({ status: "scheduled", assignee: { id: t1.id } });
  });

  it("an assignment can't race a role revocation: it waits for the revoke, then is refused", async () => {
    const tech = `${P}-t4`;
    await sql`insert into "user" (id, name, email, role) values (${tech}, 't4', ${`${P}-t4@test.local`}, 'technician')`;
    const job = await newJob();
    let outcome: Promise<number> | undefined;
    await sql.begin(async (tx) => {
      await tx`select id from "user" where id = ${tech} for update`; // what setUserRole holds while it revokes
      outcome = status(jobs.updateJob(d1, job.id, { op: "assign", version: job.version, assigneeId: tech, ...window() }));
      await new Promise((r) => setTimeout(r, 500)); // the assignment is now waiting on the lock
      await tx`update "user" set role = 'user' where id = ${tech}`;
    });
    expect(await outcome).toBe(400);
    expect((await jobs.getJob(d1, job.id)).assignee).toBeNull();
  });

  it("a time zone Postgres can't use is a 400; zones it can use work", async () => {
    const odd = await status(board.getBoard(d1, { date: "2031-03-10", tz: "America/Argentina/ComodRivadavia" }));
    expect([200, 400]).toContain(odd); // never a 500, whichever way this Postgres build answers
    expect(await status(board.getBoard(d1, { date: "2031-03-10", tz: "Nowhere/Land" }))).toBe(400);
    expect(await status(board.getBoard(d1, { date: "2031-03-10", tz: "America/Argentina/Buenos_Aires" }))).toBe(200);
  });

  it("refuses to edit a completed or cancelled job, so edits can't restart the 90-day location clock", async () => {
    const job = await assigned(t1);
    const c = await jobs.updateJob(d1, job.id, { op: "cancel", version: job.version });
    const before = (await sql`select updated_at from service_job where id = ${job.id}`)[0].updated_at;
    expect(await status(jobs.updateJob(d1, job.id, { op: "edit", version: c.version, title: "new" }))).toBe(409);
    expect((await sql`select updated_at from service_job where id = ${job.id}`)[0].updated_at).toEqual(before);
    const j2 = await assigned(t1);
    await jobs.updateJob(d1, j2.id, { op: "status", version: j2.version, to: "on_site" });
    await jobs.addJobNote(d1, j2.id, { body: "n" });
    const done = await jobs.updateJob(d1, j2.id, { op: "status", version: (await jobs.getJob(d1, j2.id)).version, to: "completed" });
    expect(await status(jobs.updateJob(d1, j2.id, { op: "edit", version: done.version, priority: "low" }))).toBe(409);
  });

  it("a technician sees check-in locations only from their own events; dispatchers see all", async () => {
    const job = await assigned(t1);
    const { db } = await import("@/lib/db");
    const loc = { lat: 30.1, lng: -97.1, accuracyM: 10, capturedAt: new Date().toISOString() };
    await db().transaction(async (tx) => {
      const row = await jobs.lockJob(tx, d1, job.id);
      await jobs.applyStatusChange(tx, d1, row, "on_site", { location: loc }); // a dispatcher-entered check-in
    });
    expect((await jobs.getJob(d1, job.id)).events.filter((e) => e.checkIn)).toHaveLength(1);
    expect((await jobs.getJob(t1, job.id)).events.filter((e) => e.checkIn)).toHaveLength(0);
    await db().transaction(async (tx) => {
      const row = await jobs.lockJob(tx, t1, job.id);
      await jobs.applyStatusChange(tx, t1, row, "on_hold", {}).catch(() => undefined);
    });
    // The technician's own check-in is visible to them.
    const j2 = await assigned(t1);
    await db().transaction(async (tx) => {
      const row = await jobs.lockJob(tx, t1, j2.id);
      await jobs.applyStatusChange(tx, t1, row, "on_site", { location: loc });
    });
    expect((await jobs.getJob(t1, j2.id)).events.filter((e) => e.checkIn)).toHaveLength(1);
  });

  it("clamps a device clientAt on notes and status events into [now - 7 days, now]", async () => {
    const job = await assigned(t1);
    const { db } = await import("@/lib/db");
    await jobs.addJobNote(t1, job.id, { body: "old", clientAt: "2001-01-01T00:00:00Z", opId: uuid() });
    await jobs.addJobNote(t1, job.id, { body: "future", clientAt: "2999-01-01T00:00:00Z", opId: uuid() });
    await db().transaction(async (tx) => {
      const row = await jobs.lockJob(tx, t1, job.id);
      await jobs.applyStatusChange(tx, t1, row, "en_route", { clientAt: new Date("2999-01-01T00:00:00Z") });
    });
    expect((await sql`select count(*)::int as n from job_note where job_id = ${job.id} and client_at is not null`)[0].n).toBe(2);
    expect((await sql`select count(*)::int as n from job_note where job_id = ${job.id} and (client_at < now() - interval '7 days 1 minute' or client_at > now())`)[0].n).toBe(0);
    expect((await sql`select count(*)::int as n from job_event where job_id = ${job.id} and client_at > now()`)[0].n).toBe(0);
    expect((await sql`select count(*)::int as n from job_event where job_id = ${job.id} and client_at is not null`)[0].n).toBe(1);
  });

  it("lists active technicians for dispatchers only", async () => {
    const { technicians } = await board.listTechnicians(d1);
    expect(technicians.map((t) => t.id)).toEqual(expect.arrayContaining([t1.id, t2.id]));
    expect(technicians.map((t) => t.id)).not.toContain(d1.id);
    expect(Object.keys(technicians[0]).sort()).toEqual(["id", "name"]);
    for (const who of [t1, admin, { id: "x", role: "user" as const }]) expect(await status(board.listTechnicians(who))).toBe(403);
    await sql`update "user" set banned = true where id = ${t2.id}`;
    expect((await board.listTechnicians(d1)).technicians.map((t) => t.id)).not.toContain(t2.id);
    await sql`update "user" set banned = false where id = ${t2.id}`;
  });

  it("assign and reopen racing a role revocation never deadlock or 500, and leave consistent data", async () => {
    const outcomes: number[] = [];
    for (let i = 0; i < 20; i++) {
      const tech = `${P}-race${i}`;
      await sql`insert into "user" (id, name, email, role) values (${tech}, ${`race ${i}`}, ${`${tech}@test.local`}, 'technician')`;
      const kind = i % 3; // 0: assign vs revoke, 1: reopen an on_hold job vs revoke, 2: reopen a completed job vs revoke
      let job = await newJob(kind === 0 ? {} : { assigneeId: tech, ...window() });
      if (kind !== 0) {
        job = await jobs.updateJob(d1, job.id, { op: "status", version: job.version, to: "on_site" });
        await jobs.addJobNote(d1, job.id, { body: "n" });
        job = await jobs.updateJob(d1, job.id, { op: "status", version: (await jobs.getJob(d1, job.id)).version, to: kind === 1 ? "on_hold" : "completed" });
      }
      const patch = kind === 0 ? { op: "assign" as const, version: job.version, assigneeId: tech, ...window() } : { op: "reopen" as const, version: job.version };
      const results = await Promise.all([
        status(jobs.updateJob(d1, job.id, patch)),
        status(adminLib.setUserRole(admin, { userId: tech, role: "user" })),
      ]);
      outcomes.push(...results);
      for (const r of results) expect([200, 400, 409], `iteration ${i}: ${results}`).toContain(r);
      // Consistent: nobody who is no longer a technician holds a working job.
      expect((await sql`select role from "user" where id = ${tech}`)[0].role).toBe("user");
      expect((await sql`select count(*)::int as n from service_job where assignee_id = ${tech} and status in ('scheduled','en_route','on_site','on_hold')`)[0].n).toBe(0);
    }
    expect(outcomes).not.toContain(500);
  });

  it("maps a database deadlock or serialization failure to a retryable 409", async () => {
    for (const code of ["40P01", "40001"]) {
      const err = Object.assign(new Error("Failed query"), { cause: Object.assign(new Error("deadlock detected"), { code }) });
      const info = errorInfo(err);
      expect(info.status).toBe(409);
      expect(info.body).toMatchObject({ code: "retry" });
      expect(JSON.stringify(info.body)).not.toContain("deadlock");
    }
  });
});
