/** Review round 4: per-user read allowance on signed-in GET data functions, throttled maintenance, and the open-job cap on reopen. */
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clean, setup, testDatabaseUrl, uuid, window, type TestUser } from "./fs-helpers";

const P = "rdl";

describe.skipIf(!testDatabaseUrl)("read limit, maintenance throttle, open-job cap (Postgres)", () => {
  let sql: postgres.Sql;
  let d1: TestUser, d2: TestUser, t1: TestUser, admin: TestUser;
  let jobs: typeof import("@/lib/service-jobs");
  let customers: typeof import("@/lib/customers");
  let parts: typeof import("@/lib/parts");
  let board: typeof import("@/lib/board");
  let adminLib: typeof import("@/lib/admin");
  let maintenance: typeof import("@/lib/maintenance");
  let caps: typeof import("@/lib/caps");
  let writeTx: typeof import("@/lib/write-tx");
  let errorInfo: typeof import("@/lib/http").errorInfo;
  let customerId: string, siteId: string;

  const status = (p: Promise<unknown>) => p.then(() => 200, (e: unknown) => errorInfo(e).status);
  const fill = (u: TestUser) =>
    sql`insert into rate_event (user_id, kind) select ${u.id}, 'read' from generate_series(1, ${writeTx.READ_LIMIT_PER_HOUR})`;

  beforeAll(async () => {
    const s = await setup(P, { d1: "dispatcher", d2: "dispatcher", t1: "technician", admin: "admin" });
    sql = s.sql;
    ({ d1, d2, t1, admin } = s.users);
    jobs = await import("@/lib/service-jobs");
    customers = await import("@/lib/customers");
    parts = await import("@/lib/parts");
    board = await import("@/lib/board");
    adminLib = await import("@/lib/admin");
    maintenance = await import("@/lib/maintenance");
    caps = await import("@/lib/caps");
    writeTx = await import("@/lib/write-tx");
    ({ errorInfo } = await import("@/lib/http"));
    customerId = (await customers.createCustomer(d1, { name: "Co", phone: "1" })).customer.id;
    siteId = (await customers.createSite(d1, customerId, { label: "S", address: "A", lat: 30.1, lng: -97.1 })).site.id;
  });
  afterAll(async () => {
    await sql`delete from rate_event where user_id like ${`${P}-%`}`;
    await clean(sql, P);
    await sql.end();
  });

  it("every signed-in GET list spends the read allowance and answers 429 at the limit", async () => {
    const job = (await jobs.createJob(d1, { customerId, siteId, title: "J" })).job;
    expect(await status(jobs.listJobs(d2, {}))).toBe(200);
    const [{ n }] = await sql`select count(*)::int as n from rate_event where user_id = ${d2.id} and kind = 'read'`;
    expect(n).toBe(1);

    await fill(d1);
    await fill(admin);
    const date = "2026-11-15";
    expect(await status(jobs.listJobs(d1, {}))).toBe(429);
    expect(await status(jobs.getJob(d1, job.id))).toBe(429);
    expect(await status(customers.listCustomers(d1, {}))).toBe(429);
    expect(await status(customers.getCustomer(d1, customerId))).toBe(429);
    expect(await status(parts.listParts(d1, {}))).toBe(429);
    expect(await status(board.listTechnicians(d1))).toBe(429);
    expect(await status(board.getBoard(d1, { date }))).toBe(429);
    expect(await status(adminLib.getAdminStats(admin))).toBe(429);
    expect(await status(adminLib.listUsers(admin, {}))).toBe(429);
    // Another user is unaffected, and a forbidden call costs nothing.
    expect(await status(board.getBoard(d2, { date }))).toBe(200);
    const [{ before }] = await sql`select count(*)::int as before from rate_event where user_id = ${t1.id}`;
    expect(await status(board.getBoard(t1, { date }))).toBe(403);
    const [{ after }] = await sql`select count(*)::int as after from rate_event where user_id = ${t1.id}`;
    expect(after).toBe(before);
  });

  it("maintenance claims its interval once, however many boards load at the same time", async () => {
    await sql`insert into maintenance_run (name, ran_at) values ('purge', now() - interval '1 hour')
              on conflict (name) do update set ran_at = excluded.ran_at`;
    const results = await Promise.all(Array.from({ length: 8 }, () => maintenance.runMaintenance()));
    expect(results.filter(Boolean).length).toBeLessThanOrEqual(1);
    expect(await maintenance.runMaintenance()).toBe(false);
    // After the interval passes it runs again, once.
    await sql`update maintenance_run set ran_at = now() - interval '11 minutes' where name = 'purge'`;
    expect(await maintenance.runMaintenance()).toBe(true);
    expect(await maintenance.runMaintenance()).toBe(false);
  });

  it("reopening a completed job respects the open-job cap, like createJob", async () => {
    const mk = async () => (await jobs.createJob(d1, { customerId, siteId, title: "Cap", assigneeId: t1.id, ...window() })).job;
    await sql`delete from rate_event where user_id = ${d1.id} and kind = 'read'`;
    // Completed directly in SQL: the status machine's path to `completed` is covered in field-jobs.
    const target = await mk();
    await sql`update service_job set status = 'completed', completed_at = now() where id = ${target.id}`;
    const fresh = await jobs.getJob(d1, target.id);

    const [{ open }] = await sql`select count(*)::int as open from service_job where status in ('unassigned','scheduled','en_route','on_site','on_hold')`;
    const original = caps.capLimits.openJobs;
    caps.capLimits.openJobs = open;
    try {
      expect(await status(jobs.updateJob(d1, target.id, { op: "reopen", version: fresh.version }))).toBe(409);
      expect(await status(jobs.createJob(d1, { customerId, siteId, title: "One more", clientOpId: uuid() }))).toBe(409);
      expect((await jobs.getJob(d1, target.id)).status).toBe("completed");
      caps.capLimits.openJobs = open + 1000;
      expect(await status(jobs.updateJob(d1, target.id, { op: "reopen", version: fresh.version }))).toBe(200);
    } finally {
      caps.capLimits.openJobs = original;
    }
  });
});
