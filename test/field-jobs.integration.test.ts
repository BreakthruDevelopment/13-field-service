/**
 * Dispatcher data layer behaviour against a real Postgres (TEST_DATABASE_URL): idempotent creates, version conflicts,
 * status rules, NUL bytes, scheduling, the board, check-in locations and their purge.
 */
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clean, setup, testDatabaseUrl, uuid, window, type TestUser } from "./fs-helpers";

const P = "fjb";

describe.skipIf(!testDatabaseUrl)("field service jobs (Postgres)", () => {
  let sql: postgres.Sql;
  let d1: TestUser, d2: TestUser, t1: TestUser, t2: TestUser, plain: TestUser;
  let jobs: typeof import("@/lib/service-jobs");
  let customers: typeof import("@/lib/customers");
  let board: typeof import("@/lib/board");
  let maintenance: typeof import("@/lib/maintenance");
  let customerId: string, siteId: string, otherCustomerId: string, otherSiteId: string;
  let errorInfo: typeof import("@/lib/http").errorInfo;

  const newJob = async (extra: Record<string, unknown> = {}) => (await jobs.createJob(d1, { customerId, siteId, title: "Job", ...extra })).job;
  const assigned = (tech: TestUser, extra: Record<string, unknown> = {}) => newJob({ assigneeId: tech.id, ...window(), ...extra });

  beforeAll(async () => {
    const s = await setup(P, { d1: "dispatcher", d2: "dispatcher", t1: "technician", t2: "technician", plain: "user" });
    sql = s.sql;
    ({ d1, d2, t1, t2, plain } = s.users);
    jobs = await import("@/lib/service-jobs");
    customers = await import("@/lib/customers");
    board = await import("@/lib/board");
    maintenance = await import("@/lib/maintenance");
    ({ errorInfo } = await import("@/lib/http"));
    const c = (await customers.createCustomer(d1, { name: "Acme", phone: "555-0100" })).customer;
    customerId = c.id;
    siteId = (await customers.createSite(d1, customerId, { label: "Main", address: "1 Main St", lat: 30.2672, lng: -97.7431 })).site.id;
    otherCustomerId = (await customers.createCustomer(d1, { name: "Other Co", phone: "555-0101" })).customer.id;
    otherSiteId = (await customers.createSite(d1, otherCustomerId, { label: "HQ", address: "2 Other Rd" })).site.id;
  });

  afterAll(async () => {
    await clean(sql, P);
    await sql.end();
  });

  describe("idempotent writes (client op ids)", () => {
    it("a duplicate clientOpId makes one job, even in parallel, and another dispatcher's same id is a separate job", async () => {
      const clientOpId = uuid();
      const first = await jobs.createJob(d1, { customerId, siteId, title: "once", clientOpId });
      expect(first.created).toBe(true);
      const results = await Promise.all([1, 2, 3, 4].map(() => jobs.createJob(d1, { customerId, siteId, title: "once", clientOpId })));
      expect(results.every((r) => r.job.id === first.job.id)).toBe(true);
      expect(results.filter((r) => r.created)).toHaveLength(0);
      expect((await sql`select count(*)::int as n from service_job where client_op_id = ${clientOpId}`)[0].n).toBe(1);
      expect((await sql`select count(*)::int as n from job_event where job_id = ${first.job.id}`)[0].n).toBe(1); // one "created", not four
      const other = await jobs.createJob(d2, { customerId, siteId, title: "once", clientOpId });
      expect(other.job.id).not.toBe(first.job.id);
      await expect(jobs.createJob(d1, { customerId, siteId, title: "x", clientOpId: "not-a-uuid" })).rejects.toMatchObject({ name: "ZodError" });
    });

    it("customers, sites and parts are idempotent too", async () => {
      const parts = await import("@/lib/parts");
      const op = uuid();
      const a = await customers.createCustomer(d1, { name: "Dup Co", phone: "1", clientOpId: op });
      const b = await Promise.all([1, 2, 3].map(() => customers.createCustomer(d1, { name: "Dup Co", phone: "1", clientOpId: op })));
      expect(b.every((r) => r.customer.id === a.customer.id && !r.created)).toBe(true);
      const sop = uuid();
      const s1 = await customers.createSite(d1, customerId, { label: "S", address: "A", clientOpId: sop });
      const s2 = await customers.createSite(d1, customerId, { label: "S", address: "A", clientOpId: sop });
      expect(s2.site.id).toBe(s1.site.id);
      const pop = uuid();
      const p1 = await parts.createPart(d1, { sku: "TST-FJB-IDEM", name: "Idem", clientOpId: pop });
      const p2 = await parts.createPart(d1, { sku: "TST-FJB-IDEM", name: "Idem", clientOpId: pop });
      expect(p2.part.id).toBe(p1.part.id);
      expect(p2.created).toBe(false);
      expect((await sql`select count(*)::int as n from part where sku = 'TST-FJB-IDEM'`)[0].n).toBe(1);
    });

    it("a note's opId is idempotent per author", async () => {
      const job = await assigned(t1);
      const opId = uuid();
      const a = await jobs.addJobNote(d1, job.id, { body: "once", opId });
      const b = await Promise.all([1, 2, 3].map(() => jobs.addJobNote(d1, job.id, { body: "once", opId })));
      expect(a.created).toBe(true);
      expect(b.every((r) => !r.created && r.job.notes.length === 1)).toBe(true);
      expect((await sql`select count(*)::int as n from job_note where job_id = ${job.id}`)[0].n).toBe(1);
    });
  });

  describe("version conflicts (409)", () => {
    it("a stale job version is refused with the current job, and nothing changes", async () => {
      const job = await assigned(t1);
      const edited = await jobs.updateJob(d1, job.id, { op: "edit", version: job.version, title: "Renamed" });
      expect(edited.version).toBe(job.version + 1);
      const err = await jobs.updateJob(d2, job.id, { op: "edit", version: job.version, title: "Stale write" }).then(() => null, (e: unknown) => e);
      const info = errorInfo(err);
      expect(info.status).toBe(409);
      expect((info.body.current as { title: string; version: number }).title).toBe("Renamed");
      expect((await jobs.getJob(d1, job.id)).title).toBe("Renamed");
      // Every op checks the version, including cancel.
      await expect(jobs.updateJob(d1, job.id, { op: "cancel", version: job.version })).rejects.toMatchObject({ status: 409 });
    });

    it("two parallel writes with the same version: one wins, one gets 409", async () => {
      const job = await assigned(t1);
      const results = await Promise.allSettled([
        jobs.updateJob(d1, job.id, { op: "edit", version: job.version, title: "A" }),
        jobs.updateJob(d2, job.id, { op: "edit", version: job.version, title: "B" }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected" && (r.reason as { status: number }).status === 409)).toHaveLength(1);
    });

    it("customers, sites and parts refuse a stale version with the current row", async () => {
      const parts = await import("@/lib/parts");
      const c = (await customers.createCustomer(d1, { name: "Versioned", phone: "1" })).customer;
      await customers.updateCustomer(d1, c.id, { version: c.version, name: "Versioned 2" });
      const e1 = errorInfo(await customers.updateCustomer(d2, c.id, { version: c.version, name: "stale" }).then(() => null, (e: unknown) => e));
      expect(e1.status).toBe(409);
      expect((e1.body.current as { name: string }).name).toBe("Versioned 2");
      const s = (await customers.createSite(d1, c.id, { label: "S", address: "A" })).site;
      await customers.updateSite(d1, s.id, { version: s.version, address: "B" });
      await expect(customers.updateSite(d1, s.id, { version: s.version, address: "C" })).rejects.toMatchObject({ status: 409 });
      const p = (await parts.createPart(d1, { sku: "TST-FJB-VER", name: "V" })).part;
      await parts.updatePart(d1, p.id, { version: p.version, active: false });
      await expect(parts.updatePart(d1, p.id, { version: p.version, active: true })).rejects.toMatchObject({ status: 409 });
    });
  });

  describe("NUL bytes and input validation (400)", () => {
    it("rejects a NUL byte in every free-text field with a validation error, not a database error", async () => {
      const parts = await import("@/lib/parts");
      const nul = "bad\0text";
      const rejects400 = async (p: Promise<unknown>) => {
        const err = await p.then(() => null, (e: unknown) => e);
        expect(errorInfo(err).status).toBe(400);
      };
      await rejects400(jobs.createJob(d1, { customerId, siteId, title: nul }));
      await rejects400(jobs.createJob(d1, { customerId, siteId, title: "ok", description: nul }));
      const job = await assigned(t1);
      await rejects400(jobs.updateJob(d1, job.id, { op: "edit", version: job.version, title: nul }));
      await rejects400(jobs.addJobNote(d1, job.id, { body: nul }));
      await rejects400(customers.createCustomer(d1, { name: nul, phone: "1" }));
      await rejects400(customers.createCustomer(d1, { name: "x", phone: nul }));
      await rejects400(customers.createCustomer(d1, { name: "x", phone: "1", notes: nul }));
      await rejects400(customers.createSite(d1, customerId, { label: "x", address: nul }));
      await rejects400(customers.createSite(d1, customerId, { label: "x", address: "x", accessNotes: nul }));
      await rejects400(parts.createPart(d1, { sku: "TST-FJB-NUL", name: nul }));
      await rejects400(parts.createPart(d1, { sku: "TST-FJB-NUL", name: "x", aliases: [nul] }));
      await rejects400(jobs.listJobs(d1, { q: nul }));
      await rejects400(parts.listParts(d1, { q: nul }));
      await rejects400(customers.listCustomers(d1, { q: nul }));
    });

    it("rejects unknown fields, bad ids, bad windows and a missing window on assignment", async () => {
      const bad = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => errorInfo(e).status);
      expect(await bad(jobs.createJob(d1, { customerId, siteId, title: "x", status: "completed" }))).toBe(400);
      expect(await bad(jobs.createJob(d1, { customerId: "nope", siteId, title: "x" }))).toBe(400);
      expect(await bad(jobs.createJob(d1, { customerId, siteId, title: "   " }))).toBe(400);
      const w = window();
      expect(await bad(jobs.createJob(d1, { customerId, siteId, title: "x", scheduledStart: w.scheduledStart }))).toBe(400); // half a window
      expect(await bad(jobs.createJob(d1, { customerId, siteId, title: "x", scheduledStart: w.scheduledEnd, scheduledEnd: w.scheduledStart }))).toBe(400); // end before start
      const long = { scheduledStart: w.scheduledStart, scheduledEnd: new Date(new Date(w.scheduledStart).getTime() + 13 * 3600_000).toISOString() };
      expect(await bad(jobs.createJob(d1, { customerId, siteId, title: "x", ...long }))).toBe(400); // over 12 hours
      expect(await bad(jobs.createJob(d1, { customerId, siteId, title: "x", assigneeId: t1.id }))).toBe(400); // assignee needs a window
      expect(await bad(jobs.createJob(d1, { customerId, siteId, title: "x", assigneeId: plain.id, ...w }))).toBe(400); // not a technician
      expect(await bad(jobs.createJob(d1, { customerId, siteId, title: "x", assigneeId: d2.id, ...w }))).toBe(400); // a dispatcher isn't a technician
      expect(await bad(jobs.getJob(d1, "not-a-uuid"))).toBe(400);
      expect(await bad(jobs.updateJob(d1, uuid(), { op: "explode", version: 1 }))).toBe(400);
    });

    it("refuses a site that belongs to another customer (404), and creates nothing", async () => {
      const before = (await sql`select count(*)::int as n from service_job where created_by = ${d1.id}`)[0].n;
      await expect(jobs.createJob(d1, { customerId, siteId: otherSiteId, title: "mismatch" })).rejects.toMatchObject({ status: 404 });
      expect((await sql`select count(*)::int as n from service_job where created_by = ${d1.id}`)[0].n).toBe(before);
      // The composite foreign key backs this up even if the application check were bypassed.
      await expect(
        sql`insert into service_job (customer_id, site_id, title, created_by) values (${customerId}, ${otherSiteId}, 'x', ${d1.id})`,
      ).rejects.toMatchObject({ code: "23503" });
    });
  });

  describe("status rules", () => {
    it("creates unassigned, or scheduled when a technician and window are given", async () => {
      const a = await newJob();
      expect(a).toMatchObject({ status: "unassigned", assignee: null, version: 1, statusVersion: 1 });
      const b = await assigned(t1);
      expect(b).toMatchObject({ status: "scheduled", assignee: { id: t1.id } });
      expect(b.events.map((e) => e.kind)).toEqual(["created", "assigned"]);
    });

    it("assign, reassign and unassign move the status and bump statusVersion; reschedule does not", async () => {
      const job = await newJob();
      const w = window(3);
      const a = await jobs.updateJob(d1, job.id, { op: "assign", version: job.version, assigneeId: t1.id, ...w });
      expect(a).toMatchObject({ status: "scheduled", assignee: { id: t1.id }, statusVersion: 2, version: 2 });
      const r = await jobs.updateJob(d1, job.id, { op: "reschedule", version: a.version, ...window(5) });
      expect(r).toMatchObject({ status: "scheduled", statusVersion: 2, version: 3 }); // a queued offline status change still applies
      const re = await jobs.updateJob(d1, job.id, { op: "assign", version: r.version, assigneeId: t2.id });
      expect(re).toMatchObject({ assignee: { id: t2.id }, statusVersion: 3 });
      expect(re.scheduledStart).toBe(r.scheduledStart); // keeps its window
      const u = await jobs.updateJob(d1, job.id, { op: "unassign", version: re.version });
      expect(u).toMatchObject({ status: "unassigned", assignee: null, statusVersion: 4 });
      await expect(jobs.updateJob(d1, job.id, { op: "unassign", version: u.version })).rejects.toMatchObject({ status: 409 });
      expect(u.events.map((e) => e.kind)).toEqual(["created", "assigned", "rescheduled", "assigned", "unassigned"]);
    });

    it("assigning an unassigned job with no window needs one (400)", async () => {
      const job = await newJob();
      await expect(jobs.updateJob(d1, job.id, { op: "assign", version: job.version, assigneeId: t1.id })).rejects.toMatchObject({ status: 400 });
    });

    it("walks scheduled -> en_route -> on_site -> completed, needing a note to complete", async () => {
      const job = await assigned(t1);
      const en = await jobs.updateJob(d1, job.id, { op: "status", version: job.version, to: "en_route" });
      expect(en.status).toBe("en_route");
      const on = await jobs.updateJob(d1, job.id, { op: "status", version: en.version, to: "on_site" });
      const noNote = await jobs.updateJob(d1, job.id, { op: "status", version: on.version, to: "completed" }).then(() => null, (e: unknown) => e);
      expect(noNote).toMatchObject({ status: 409, code: "note_required" });
      await jobs.addJobNote(t1, job.id, { body: "Replaced the cartridge." });
      const fresh = await jobs.getJob(d1, job.id);
      const done = await jobs.updateJob(d1, job.id, { op: "status", version: fresh.version, to: "completed" });
      expect(done.status).toBe("completed");
      expect(done.completedAt).not.toBeNull();
    });

    it("refuses moves the machine doesn't allow (409), including leaving a closed job", async () => {
      const job = await assigned(t1);
      for (const to of ["completed", "on_hold", "unassigned", "scheduled", "cancelled"] as const) {
        const err = await jobs.updateJob(d1, job.id, { op: "status", version: job.version, to }).then(() => null, (e: unknown) => e);
        expect(err, to).toMatchObject({ status: 409, code: "transition_not_allowed" });
      }
      const cancelled = await jobs.updateJob(d1, job.id, { op: "cancel", version: job.version });
      expect(cancelled.status).toBe("cancelled");
      await expect(jobs.updateJob(d1, job.id, { op: "status", version: cancelled.version, to: "en_route" })).rejects.toMatchObject({ status: 409, code: "job_closed" });
      await expect(jobs.updateJob(d1, job.id, { op: "cancel", version: cancelled.version })).rejects.toMatchObject({ status: 409 });
      await expect(jobs.updateJob(d1, job.id, { op: "assign", version: cancelled.version, assigneeId: t2.id, ...window() })).rejects.toMatchObject({ status: 409 });
      await expect(jobs.updateJob(d1, job.id, { op: "reschedule", version: cancelled.version, ...window() })).rejects.toMatchObject({ status: 409 });
      await expect(jobs.updateJob(d1, job.id, { op: "reopen", version: cancelled.version })).rejects.toMatchObject({ status: 409 });
    });

    it("on_hold needs a note, resumes without one, and a held or completed job can be reopened", async () => {
      const job = await assigned(t1);
      let v = (await jobs.updateJob(d1, job.id, { op: "status", version: job.version, to: "on_site" })).version;
      await expect(jobs.updateJob(d1, job.id, { op: "status", version: v, to: "on_hold" })).rejects.toMatchObject({ code: "note_required" });
      await jobs.addJobNote(d1, job.id, { body: "Waiting on a part." });
      v = (await jobs.getJob(d1, job.id)).version;
      const hold = await jobs.updateJob(d1, job.id, { op: "status", version: v, to: "on_hold" });
      const resumed = await jobs.updateJob(d1, job.id, { op: "status", version: hold.version, to: "on_site" });
      expect(resumed.status).toBe("on_site");
      const hold2 = await jobs.updateJob(d1, job.id, { op: "status", version: resumed.version, to: "on_hold" });
      const reopened = await jobs.updateJob(d1, job.id, { op: "reopen", version: hold2.version });
      expect(reopened).toMatchObject({ status: "scheduled", completedAt: null });
      await expect(jobs.updateJob(d1, job.id, { op: "reopen", version: reopened.version })).rejects.toMatchObject({ status: 409 });
      // completed -> reopen
      const on = await jobs.updateJob(d1, job.id, { op: "status", version: reopened.version, to: "on_site" });
      const done = await jobs.updateJob(d1, job.id, { op: "status", version: on.version, to: "completed" });
      const again = await jobs.updateJob(d1, job.id, { op: "reopen", version: done.version });
      expect(again).toMatchObject({ status: "scheduled", completedAt: null });
    });

    it("the database refuses a status that doesn't match the assignee, even around the data layer", async () => {
      const job = await newJob();
      await expect(sql`update service_job set status = 'scheduled' where id = ${job.id}`).rejects.toMatchObject({ code: "23514" });
      await expect(sql`update service_job set status = 'en_route', assignee_id = ${t1.id}, scheduled_start = now(), scheduled_end = now() + interval '13 hours' where id = ${job.id}`).rejects.toMatchObject({ code: "23514" });
    });

    it("a check-in location is stored rounded, only on a move to on_site, and shows the distance from the site", async () => {
      const job = await assigned(t1);
      const loc = { lat: 30.267153, lng: -97.743061, accuracyM: 24.6, capturedAt: new Date(Date.now() - 60_000).toISOString() };
      const result = await (await import("@/lib/db")).db().transaction(async (tx) => {
        const row = await jobs.lockJob(tx, t1, job.id);
        await expect(jobs.applyStatusChange(tx, t1, row, "en_route", { location: loc })).rejects.toMatchObject({ status: 400 });
        return jobs.applyStatusChange(tx, t1, row, "on_site", { location: loc });
      });
      expect(result.status).toBe("on_site");
      const detail = await jobs.getJob(t1, job.id);
      const checkIn = detail.events.at(-1)!.checkIn!;
      expect(checkIn).toMatchObject({ lat: 30.2672, lng: -97.7431, accuracyM: 25, late: false });
      expect(checkIn.distanceFromSiteM).toBeLessThan(10);
      // Dispatchers of the job see it too; there's no location in the database for the other events.
      expect((await jobs.getJob(d1, job.id)).events.filter((e) => e.checkIn)).toHaveLength(1);
      expect((await sql`select count(*)::int as n from job_event where job_id = ${job.id} and lat is not null`)[0].n).toBe(1);
      // The table itself refuses a location on any other event.
      await expect(sql`insert into job_event (job_id, actor_id, kind, to_status, lat, lng) values (${job.id}, ${t1.id}, 'status', 'completed', 1, 1)`).rejects.toMatchObject({ code: "23514" });
    });
  });

  describe("cap and rate limits", () => {
    it("caps notes at 200 per job (409)", async () => {
      const job = await assigned(t1);
      await sql`insert into job_note (job_id, author_id, body) select ${job.id}, ${d1.id}, 'n' || g from generate_series(1, 200) g`;
      await expect(jobs.addJobNote(d1, job.id, { body: "one too many" })).rejects.toMatchObject({ status: 409 });
    });

    it("refuses writes past 300 an hour with 429, and a refused write costs nothing", async () => {
      const { createCustomer } = customers;
      const spender = (await sql`insert into "user" (id, name, email, role) values (${`${P}-spender`}, 's', ${`${P}-spender@test.local`}, 'dispatcher') returning id`)[0].id as string;
      await sql`insert into rate_event (user_id, kind, at) select ${spender}, 'api_write', now() - (g || ' seconds')::interval from generate_series(1, 300) g`;
      await expect(createCustomer({ id: spender, role: "dispatcher" }, { name: "x", phone: "1" })).rejects.toMatchObject({ status: 429 });
      expect((await sql`select count(*)::int as n from customer where created_by = ${spender}`)[0].n).toBe(0);
      expect((await sql`select count(*)::int as n from rate_event where user_id = ${spender} and kind = 'api_write'`)[0].n).toBe(300);
    });
  });

  describe("list and filters", () => {
    it("filters by status and customer and pages with hasMore", async () => {
      const c = (await customers.createCustomer(d1, { name: "Filter Co", phone: "1" })).customer;
      const s = (await customers.createSite(d1, c.id, { label: "S", address: "77 Filter Way" })).site;
      for (let i = 0; i < 3; i++) await jobs.createJob(d1, { customerId: c.id, siteId: s.id, title: `Filter job ${i}` });
      const page1 = await jobs.listJobs(d1, { customerId: c.id, limit: 2 });
      expect(page1.jobs).toHaveLength(2);
      expect(page1.hasMore).toBe(true);
      const page2 = await jobs.listJobs(d1, { customerId: c.id, limit: 2, offset: 2 });
      expect(page2.jobs).toHaveLength(1);
      expect(page2.hasMore).toBe(false);
      expect((await jobs.listJobs(d1, { customerId: c.id, status: "completed" })).jobs).toHaveLength(0);
      expect((await jobs.listJobs(d1, { q: "77 filter way" })).jobs).toHaveLength(3);
      expect((await jobs.listJobs(d1, { q: "100%" })).jobs).toHaveLength(0); // a LIKE wildcard is literal
      await expect(jobs.listJobs(d1, { surprise: "1" })).rejects.toMatchObject({ name: "ZodError" });
    });
  });

  describe("board", () => {
    it("shows the day's assigned jobs, the unassigned tray, every technician, and honours the time zone", async () => {
      // 02:00 UTC on 2031-03-10 is still 2031-03-09 in Chicago.
      const day = "2031-03-10";
      const mk = (title: string, start: string, end: string, tech?: TestUser) =>
        newJob({ title, scheduledStart: start, scheduledEnd: end, ...(tech ? { assigneeId: tech.id } : {}) });
      const morning = await mk("BOARD-morning", `${day}T14:00:00Z`, `${day}T15:00:00Z`, t1);
      const late = await mk("BOARD-late-utc", `${day}T02:00:00Z`, `${day}T03:00:00Z`, t2);
      const nextDay = await mk("BOARD-next-day", "2031-03-11T14:00:00Z", "2031-03-11T15:00:00Z", t1);
      const tray = await newJob({ title: "BOARD-tray" });
      const cancelled = await mk("BOARD-cancelled", `${day}T16:00:00Z`, `${day}T17:00:00Z`, t1);
      await jobs.updateJob(d1, cancelled.id, { op: "cancel", version: cancelled.version });

      const utc = await board.getBoard(d1, { date: day });
      const titles = (list: { title: string }[]) => list.map((j) => j.title).filter((t) => t.startsWith("BOARD-")).sort();
      expect(titles(utc.jobs)).toEqual(["BOARD-late-utc", "BOARD-morning"]);
      expect(titles(utc.unassigned)).toEqual(["BOARD-tray"]);
      expect(utc.technicians.map((t) => t.id)).toEqual(expect.arrayContaining([t1.id, t2.id]));
      expect(utc.technicians.map((t) => t.id)).not.toContain(plain.id);
      expect(utc.truncated).toBe(false);

      const chicago = await board.getBoard(d1, { date: day, tz: "America/Chicago" });
      expect(titles(chicago.jobs)).toEqual(["BOARD-morning"]); // the 02:00 UTC job belongs to the 9th in Chicago
      expect(titles((await board.getBoard(d1, { date: "2031-03-09", tz: "America/Chicago" })).jobs)).toEqual(["BOARD-late-utc"]);
      expect(morning.id).toBeTruthy();
      expect(late.id && nextDay.id && tray.id).toBeTruthy();

      for (const bad of [{ date: "2031-02-30" }, { date: "tomorrow" }, { date: day, tz: "Mars/Olympus" }, { date: day, tz: "x'; drop table" }, {}]) {
        const err = await board.getBoard(d1, bad).then(() => null, (e: unknown) => e);
        expect(errorInfo(err).status, JSON.stringify(bad)).toBe(400);
      }
    });
  });

  describe("location purge and ledger pruning", () => {
    it("nulls check-in coordinates 90 days after a job completes (and after a cancel), only then, and is idempotent", async () => {
      const mkOnSite = async () => {
        const job = await assigned(t1);
        await (await import("@/lib/db")).db().transaction(async (tx) => {
          const row = await jobs.lockJob(tx, t1, job.id);
          await jobs.applyStatusChange(tx, t1, row, "on_site", { location: { lat: 30.1, lng: -97.1, accuracyM: 10, capturedAt: new Date().toISOString() } });
        });
        return job.id;
      };
      const open = await mkOnSite();
      const recent = await mkOnSite();
      const old = await mkOnSite();
      const oldCancelled = await mkOnSite();
      await sql`update service_job set status = 'completed', completed_at = now() - interval '89 days' where id = ${recent}`;
      await sql`update service_job set status = 'completed', completed_at = now() - interval '91 days' where id = ${old}`;
      await sql`update service_job set status = 'cancelled', updated_at = now() - interval '91 days' where id = ${oldCancelled}`;
      const located = async (id: string) => (await sql`select count(*)::int as n from job_event where job_id = ${id} and lat is not null`)[0].n as number;

      const cleared = await maintenance.purgeStaleLocations();
      expect(cleared).toBeGreaterThanOrEqual(2);
      expect(await located(open)).toBe(1);
      expect(await located(recent)).toBe(1);
      expect(await located(old)).toBe(0);
      expect(await located(oldCancelled)).toBe(0);
      expect((await sql`select lat, lng, accuracy_m, captured_at, to_status from job_event where job_id = ${old} and to_status = 'on_site'`)[0]).toMatchObject({ lat: null, lng: null, accuracy_m: null, captured_at: null });
      expect(await maintenance.purgeStaleLocations()).toBe(0); // nothing left to do
      // The board load runs it lazily (at most once per interval, so make the interval look elapsed).
      await sql`insert into maintenance_run (name, ran_at) values ('purge', now() - interval '1 hour') on conflict (name) do update set ran_at = excluded.ran_at`;
      await sql`update service_job set status = 'completed', completed_at = now() - interval '100 days' where id = ${recent}`;
      await board.getBoard(d1, { date: "2031-03-10" });
      expect(await located(recent)).toBe(0);
    });

    it("prunes replay-ledger rows older than 30 days", async () => {
      const old = uuid();
      const fresh = uuid();
      await sql`insert into sync_op (actor_id, op_id, kind, payload_hash, outcome, received_at) values (${t1.id}, ${old}, 'note.add', 'h', 'applied', now() - interval '31 days')`;
      await sql`insert into sync_op (actor_id, op_id, kind, payload_hash, outcome) values (${t1.id}, ${fresh}, 'note.add', 'h', 'applied')`;
      await maintenance.pruneSyncOps();
      expect((await sql`select op_id from sync_op where actor_id = ${t1.id}`).map((r) => r.op_id)).toEqual([fresh]);
    });
  });

  describe("customers, sites and parts", () => {
    it("validates email and coordinates", async () => {
      const bad = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => errorInfo(e).status);
      expect(await bad(customers.createCustomer(d1, { name: "x", phone: "1", email: "not an email" }))).toBe(400);
      expect(await bad(customers.createSite(d1, customerId, { label: "x", address: "x", lat: 95, lng: 0 }))).toBe(400);
      expect(await bad(customers.createSite(d1, customerId, { label: "x", address: "x", lat: 10 }))).toBe(400); // both or neither
      const c = (await customers.createCustomer(d1, { name: "Mail Co", phone: "1", email: "a@b.example" })).customer;
      expect(c.email).toBe("a@b.example");
      const blank = (await customers.createCustomer(d1, { name: "No Mail", phone: "1", email: "" })).customer;
      expect(blank.email).toBeNull();
    });

    it("keeps SKUs unique and searchable by SKU, name and alias prefix", async () => {
      const parts = await import("@/lib/parts");
      await parts.createPart(d1, { sku: "tst-fjb-pex", name: "PEX tubing 1/2 in", unit: "ft", aliases: ["crosslinked"] });
      await expect(parts.createPart(d1, { sku: "TST-FJB-PEX", name: "Dupe" })).rejects.toMatchObject({ status: 409 });
      for (const q of ["TST-FJB-PEX", "tubing", "cross", "pex 1/2"]) {
        expect((await parts.listParts(d1, { q })).parts.map((p) => p.sku), q).toContain("TST-FJB-PEX");
      }
      expect((await parts.listParts(d1, { q: "zzzznope" })).parts).toEqual([]);
      expect((await parts.listParts(d1, { q: "'); drop table part; --" })).parts).toEqual([]);
      await expect(parts.createPart(d1, { sku: "bad sku!", name: "x" })).rejects.toMatchObject({ name: "ZodError" });
      await expect(parts.createPart(d1, { sku: "TST-FJB-UNIT", name: "x", unit: "parsec" })).rejects.toMatchObject({ name: "ZodError" });
    });
  });
});
