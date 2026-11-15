/**
 * Every access rule of the field-service data layer, against a real Postgres (TEST_DATABASE_URL): who may read and write
 * what, and that a technician guessing ids learns nothing. The rule table is in src/lib/access.ts.
 */
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clean, setup, testDatabaseUrl, uuid, window, type TestUser } from "./fs-helpers";

const P = "acc";

describe.skipIf(!testDatabaseUrl)("access rules (Postgres)", () => {
  let sql: postgres.Sql;
  let d1: TestUser, d2: TestUser, t1: TestUser, t2: TestUser, admin: TestUser, plain: TestUser;
  let jobs: typeof import("@/lib/service-jobs");
  let customers: typeof import("@/lib/customers");
  let parts: typeof import("@/lib/parts");
  let board: typeof import("@/lib/board");
  let adminLib: typeof import("@/lib/admin");
  let customerId: string, siteId: string;
  let job1: string, job2: string, job3: string;

  beforeAll(async () => {
    const s = await setup(P, { d1: "dispatcher", d2: "dispatcher", t1: "technician", t2: "technician", admin: "admin", plain: "user" });
    sql = s.sql;
    ({ d1, d2, t1, t2, admin, plain } = s.users);
    jobs = await import("@/lib/service-jobs");
    customers = await import("@/lib/customers");
    parts = await import("@/lib/parts");
    board = await import("@/lib/board");
    adminLib = await import("@/lib/admin");

    const { customer } = await customers.createCustomer(d1, { name: "Acme Bakery", phone: "555-0100", email: "owner@acme.example", notes: "PRIVATE-CUSTOMER-NOTE" });
    customerId = customer.id;
    const { site } = await customers.createSite(d1, customerId, { label: "Main", address: "1 Main St", accessNotes: "Side door", lat: 30.2672, lng: -97.7431 });
    siteId = site.id;
    const mk = async (title: string, assigneeId?: string) =>
      (await jobs.createJob(d1, { customerId, siteId, title, ...(assigneeId ? { assigneeId, ...window() } : {}) })).job.id;
    job1 = await mk("Job for t1", t1.id);
    job2 = await mk("Job for t2", t2.id);
    job3 = await mk("Unassigned job");
    await jobs.addJobNote(d1, job1, { body: "Dispatcher note on job1" });
    await jobs.addJobNote(d1, job2, { body: "SECRET-NOTE-ON-JOB2" });
  });

  afterAll(async () => {
    await clean(sql, P);
    await sql.end();
  });

  describe("technician", () => {
    it("lists only their own jobs", async () => {
      const { jobs: mine } = await jobs.listJobs(t1, {});
      expect(mine.map((j) => j.id)).toEqual([job1]);
      const { jobs: theirs } = await jobs.listJobs(t2, {});
      expect(theirs.map((j) => j.id)).toEqual([job2]);
      // Filters can't widen the scope.
      expect((await jobs.listJobs(t1, { assigneeId: t2.id })).jobs).toEqual([]);
      expect((await jobs.listJobs(t1, { q: "Job for t2" })).jobs).toEqual([]);
    });

    it("reads their own job with the customer's name and phone, the site, and notes, but not the customer's email or notes", async () => {
      const job = await jobs.getJob(t1, job1);
      expect(job.customer).toMatchObject({ name: "Acme Bakery", phone: "555-0100" });
      expect(job.site).toMatchObject({ address: "1 Main St" });
      expect(job.siteDetail.accessNotes).toBe("Side door");
      expect(job.notes.map((n) => n.body)).toEqual(["Dispatcher note on job1"]);
      expect(job.customerDetail).toBeNull();
      expect(JSON.stringify(job)).not.toContain("owner@acme.example");
      expect(JSON.stringify(job)).not.toContain("PRIVATE-CUSTOMER-NOTE");
    });

    it("id guessing: another technician's job, an unassigned job and a made-up id all answer the same 404", async () => {
      const answers = [];
      for (const id of [job2, job3, uuid()]) {
        const err = await jobs.getJob(t1, id).then(() => null, (e: unknown) => e);
        answers.push(err);
      }
      for (const err of answers) expect(err).toMatchObject({ status: 404, message: "Job not found" });
      expect(JSON.stringify(answers.map((e) => (e as Error).message))).not.toContain("SECRET");
    });

    it("cannot add a note to, or otherwise touch, a job that isn't theirs (404), and nothing is written", async () => {
      for (const id of [job2, job3, uuid()]) {
        await expect(jobs.addJobNote(t1, id, { body: "sneaky" })).rejects.toMatchObject({ status: 404 });
      }
      expect((await sql`select count(*)::int as n from job_note where body = 'sneaky'`)[0].n).toBe(0);
      const own = await jobs.addJobNote(t1, job1, { body: "My own note" });
      expect(own.job.notes.map((n) => n.body)).toContain("My own note");
    });

    it("cannot create or update jobs, read customers or sites, see the board, or write parts (403)", async () => {
      await expect(jobs.createJob(t1, { customerId, siteId, title: "x" })).rejects.toMatchObject({ status: 403 });
      await expect(jobs.updateJob(t1, job1, { op: "cancel", version: 1 })).rejects.toMatchObject({ status: 403 });
      await expect(jobs.updateJob(t1, job2, { op: "cancel", version: 1 })).rejects.toMatchObject({ status: 403 });
      await expect(customers.listCustomers(t1, {})).rejects.toMatchObject({ status: 403 });
      await expect(customers.getCustomer(t1, customerId)).rejects.toMatchObject({ status: 403 });
      await expect(customers.createCustomer(t1, { name: "x", phone: "1" })).rejects.toMatchObject({ status: 403 });
      await expect(customers.updateCustomer(t1, customerId, { version: 1, name: "x" })).rejects.toMatchObject({ status: 403 });
      await expect(customers.createSite(t1, customerId, { label: "x", address: "x" })).rejects.toMatchObject({ status: 403 });
      await expect(board.getBoard(t1, { date: "2026-11-15" })).rejects.toMatchObject({ status: 403 });
      await expect(parts.createPart(t1, { sku: "TST-ACC-NOPE", name: "x" })).rejects.toMatchObject({ status: 403 });
      await expect(adminLib.getAdminStats(t1)).rejects.toMatchObject({ status: 403 });
      await expect(adminLib.setUserRole(t1, { userId: t1.id, role: "dispatcher" })).rejects.toMatchObject({ status: 403 });
      expect((await sql`select role from "user" where id = ${t1.id}`)[0].role).toBe("technician");
    });

    it("reads the parts catalog (active parts only)", async () => {
      const { part } = (await parts.createPart(d1, { sku: "TST-ACC-LIVE", name: "Live part" })) as { part: { id: string } };
      const { part: hidden } = await parts.createPart(d1, { sku: "TST-ACC-OLD", name: "Retired part", active: false });
      const seen = (await parts.listParts(t1, { q: "TST-ACC" })).parts.map((p) => p.sku);
      expect(seen).toEqual(["TST-ACC-LIVE"]);
      // `includeInactive` is a dispatcher option; a technician asking for it still gets active parts only.
      expect((await parts.listParts(t1, { q: "TST-ACC", includeInactive: "true" })).parts.map((p) => p.sku)).toEqual(["TST-ACC-LIVE"]);
      expect((await parts.listParts(d1, { q: "TST-ACC", includeInactive: "true" })).parts.map((p) => p.sku).sort()).toEqual(["TST-ACC-LIVE", "TST-ACC-OLD"]);
      expect(part.id).not.toBe(hidden.id);
    });
  });

  describe("dispatcher", () => {
    it("sees every job, customer, site and note, with the customer's email and notes", async () => {
      const ids = (await jobs.listJobs(d2, {})).jobs.map((j) => j.id);
      expect(ids).toEqual(expect.arrayContaining([job1, job2, job3]));
      const job = await jobs.getJob(d2, job2);
      expect(job.notes.map((n) => n.body)).toContain("SECRET-NOTE-ON-JOB2");
      expect(job.customerDetail).toEqual({ email: "owner@acme.example", notes: "PRIVATE-CUSTOMER-NOTE" });
      const detail = await customers.getCustomer(d2, customerId); // a different dispatcher than the creator
      expect(detail.sites).toHaveLength(1);
      expect(detail.jobs.length).toBeGreaterThanOrEqual(3);
      expect((await customers.listCustomers(d2, { q: "acme" })).customers.map((c) => c.id)).toContain(customerId);
    });

    it("answers 404 for a made-up job, customer or site id", async () => {
      await expect(jobs.getJob(d1, uuid())).rejects.toMatchObject({ status: 404 });
      await expect(jobs.updateJob(d1, uuid(), { op: "cancel", version: 1 })).rejects.toMatchObject({ status: 404 });
      await expect(customers.getCustomer(d1, uuid())).rejects.toMatchObject({ status: 404 });
      await expect(customers.createSite(d1, uuid(), { label: "x", address: "x" })).rejects.toMatchObject({ status: 404 });
      await expect(customers.updateSite(d1, uuid(), { version: 1, label: "x" })).rejects.toMatchObject({ status: 404 });
    });

    it("has no admin powers: counts, roles, the user directory and the demo button are refused (403)", async () => {
      await expect(adminLib.getAdminStats(d1)).rejects.toMatchObject({ status: 403 });
      await expect(adminLib.listUsers(d1, {})).rejects.toMatchObject({ status: 403 });
      await expect(adminLib.setUserRole(d1, { userId: t2.id, role: "dispatcher" })).rejects.toMatchObject({ status: 403 });
      await expect(adminLib.loadDemo(d1)).rejects.toMatchObject({ status: 403 });
    });
  });

  describe("admin", () => {
    it("gets counts, the user directory and role grants", async () => {
      const stats = await adminLib.getAdminStats(admin);
      expect(stats.jobsByStatus.scheduled).toBeGreaterThanOrEqual(2);
      expect(stats.usersByRole.technician).toBeGreaterThanOrEqual(2);
      expect(stats.ai.cap).toBeGreaterThan(0);
      // Counts only: no titles, names, notes or customer data anywhere in the payload.
      const text = JSON.stringify(stats);
      for (const secret of ["Acme", "Job for t1", "SECRET", "owner@acme.example", "PRIVATE"]) expect(text).not.toContain(secret);
      const { users } = await adminLib.listUsers(admin, { q: P });
      expect(users.length).toBeGreaterThanOrEqual(6);
      expect(Object.keys(users[0]).sort()).toEqual(["createdAt", "email", "id", "name", "role"]);
    });

    it("cannot read or change any job, customer, site, note or part, and never sees the board (403)", async () => {
      await expect(jobs.listJobs(admin, {})).rejects.toMatchObject({ status: 403 });
      await expect(jobs.getJob(admin, job1)).rejects.toMatchObject({ status: 403 });
      await expect(jobs.createJob(admin, { customerId, siteId, title: "x" })).rejects.toMatchObject({ status: 403 });
      await expect(jobs.updateJob(admin, job1, { op: "cancel", version: 1 })).rejects.toMatchObject({ status: 403 });
      await expect(jobs.addJobNote(admin, job1, { body: "x" })).rejects.toMatchObject({ status: 403 });
      await expect(customers.listCustomers(admin, {})).rejects.toMatchObject({ status: 403 });
      await expect(customers.getCustomer(admin, customerId)).rejects.toMatchObject({ status: 403 });
      await expect(customers.createCustomer(admin, { name: "x", phone: "1" })).rejects.toMatchObject({ status: 403 });
      await expect(parts.listParts(admin, {})).rejects.toMatchObject({ status: 403 });
      await expect(parts.createPart(admin, { sku: "TST-ACC-ADM", name: "x" })).rejects.toMatchObject({ status: 403 });
      await expect(board.getBoard(admin, { date: "2026-11-15" })).rejects.toMatchObject({ status: 403 });
    });
  });

  describe("user (a new sign-up with no role)", () => {
    it("can do nothing: every function answers 403", async () => {
      await expect(jobs.listJobs(plain, {})).rejects.toMatchObject({ status: 403 });
      await expect(jobs.getJob(plain, job1)).rejects.toMatchObject({ status: 403 });
      await expect(customers.listCustomers(plain, {})).rejects.toMatchObject({ status: 403 });
      await expect(parts.listParts(plain, {})).rejects.toMatchObject({ status: 403 });
      await expect(board.getBoard(plain, { date: "2026-11-15" })).rejects.toMatchObject({ status: 403 });
      await expect(adminLib.getAdminStats(plain)).rejects.toMatchObject({ status: 403 });
      await expect(adminLib.setUserRole(plain, { userId: plain.id, role: "dispatcher" })).rejects.toMatchObject({ status: 403 });
      expect((await sql`select role from "user" where id = ${plain.id}`)[0].role).toBe("user");
    });
  });
});
