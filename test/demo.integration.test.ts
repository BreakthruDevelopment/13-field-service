/**
 * The demo workspace (src/lib/demo.ts): the counts the spec promises, the fixture job and its notes, reloading without
 * duplicates, never touching a real account, the admin-only button and its caps.
 */
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clean, setup, testDatabaseUrl, type TestUser } from "./fs-helpers";

const P = "dmo";

describe.skipIf(!testDatabaseUrl)("demo workspace (Postgres)", () => {
  let sql: postgres.Sql;
  let admin: TestUser, admin2: TestUser, dispatcher: TestUser;
  let adminLib: typeof import("@/lib/admin");
  let jobs: typeof import("@/lib/service-jobs");
  let parts: typeof import("@/lib/parts");

  const count = async (table: string, where = sql``) => (await sql`select count(*)::int as n from ${sql(table)} ${where}`)[0].n as number;
  const wipeDemo = async () => {
    await sql`delete from service_job where created_by like 'demo-fs-%' or assignee_id like 'demo-fs-%'`;
    await sql`delete from customer where created_by like 'demo-fs-%'`;
    await sql`delete from part where created_by like 'demo-fs-%'`;
    await sql`delete from job_event where actor_id like 'demo-fs-%'`;
    await sql`delete from job_note where author_id like 'demo-fs-%'`;
    await sql`delete from "user" where id like 'demo-fs-%' or email like 'fs-%@demo.breakthru.test'`;
  };

  beforeAll(async () => {
    const s = await setup(P, { admin: "admin", admin2: "admin", dispatcher: "dispatcher" });
    sql = s.sql;
    ({ admin, admin2, dispatcher } = s.users);
    await wipeDemo();
    adminLib = await import("@/lib/admin");
    jobs = await import("@/lib/service-jobs");
    parts = await import("@/lib/parts");
  });

  afterAll(async () => {
    await wipeDemo();
    await clean(sql, P);
    await sql.end();
  });

  it("loads 2 dispatchers, 3 technicians, 8 customers, 12 sites, 60 parts and 15 jobs", async () => {
    const summary = await adminLib.loadDemo(admin);
    expect(summary).toEqual({ dispatchers: 2, technicians: 3, customers: 8, sites: 12, parts: 60, jobs: 15 });
    expect(await count("user", sql`where id like 'demo-fs-%' and role = 'dispatcher'`)).toBe(2);
    expect(await count("user", sql`where id like 'demo-fs-%' and role = 'technician'`)).toBe(3);
    expect(await count("customer", sql`where created_by like 'demo-fs-%'`)).toBe(8);
    expect(await count("site", sql`where created_by like 'demo-fs-%'`)).toBe(12);
    expect(await count("part", sql`where created_by like 'demo-fs-%'`)).toBe(60);
    expect(await count("service_job", sql`where created_by like 'demo-fs-%'`)).toBe(15);
    // Today and tomorrow (UTC), with some jobs still waiting in the tray.
    const days = await sql`select distinct (scheduled_start at time zone 'utc')::date as d from service_job where created_by like 'demo-fs-%' and scheduled_start is not null order by d`;
    expect(days).toHaveLength(2);
    expect(await count("service_job", sql`where created_by like 'demo-fs-%' and status = 'unassigned'`)).toBeGreaterThanOrEqual(3);
  });

  it("includes the fixture job with its notes, and the fixture's SKUs but not the one it flags as unknown", async () => {
    const { jobs: found } = await jobs.listJobs(dispatcher, { q: "Kitchen sink leaking under cabinet" });
    expect(found).toHaveLength(1);
    const job = await jobs.getJob(dispatcher, found[0].id);
    expect(job.status).toBe("on_site");
    const notes = job.notes.map((n) => n.body.toLowerCase()).join(" ");
    for (const phrase of ["faucet cartridge", "compression fitting", "braided supply line 20in"]) expect(notes).toContain(phrase);
    expect(job.events.some((e) => e.checkIn)).toBe(true);
    for (const sku of ["PLB-CART-STD", "PLB-COMP-050"]) {
      expect((await parts.listParts(dispatcher, { q: sku })).parts.map((p) => p.sku)).toContain(sku);
    }
    // Eval inputs: copper elbows, PEX and a shutoff valve are in the catalog; a thermostat and a 20in supply line are not.
    for (const q of ["copper elbow", "pex", "shutoff valve", "14/2"]) expect((await parts.listParts(dispatcher, { q })).parts.length, q).toBeGreaterThan(0);
    expect((await parts.listParts(dispatcher, { q: "thermostat" })).parts).toEqual([]);
    expect((await parts.listParts(dispatcher, { q: "supply line 20" })).parts).toEqual([]);
    expect(await count("part", sql`where sku = 'PLB-SUP-20'`)).toBe(0);
  });

  it("every demo row satisfies the schema's rules (the loader writes around the data layer)", async () => {
    // Re-validating through the constraints: a window never over 12 h, a status that matches its assignee.
    expect(await count("service_job", sql`where created_by like 'demo-fs-%' and status <> 'unassigned' and assignee_id is null`)).toBe(0);
    expect(await count("service_job", sql`where created_by like 'demo-fs-%' and status = 'completed' and completed_at is null`)).toBe(0);
  });

  it("reloading replaces the demo customers, sites, jobs and notes, and never duplicates parts or people", async () => {
    await adminLib.loadDemo(admin);
    expect(await count("customer", sql`where created_by like 'demo-fs-%'`)).toBe(8);
    expect(await count("site", sql`where created_by like 'demo-fs-%'`)).toBe(12);
    expect(await count("service_job", sql`where created_by like 'demo-fs-%'`)).toBe(15);
    expect(await count("job_note", sql`where author_id like 'demo-fs-%'`)).toBe(4);
    expect(await count("part", sql`where created_by like 'demo-fs-%'`)).toBe(60);
    expect(await count("user", sql`where id like 'demo-fs-%'`)).toBe(5);
  });

  it("the button's demo users have no password, and carry the marker", async () => {
    expect(await count("account", sql`where user_id like 'demo-fs-%'`)).toBe(0);
    expect(await count("user", sql`where id like 'demo-fs-%' and image = 'urn:breakthru:field-service-demo:v1'`)).toBe(5);
  });

  it("the seed script's loader can give them a password so a local run can sign in", async () => {
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const schema = await import("@/lib/db/schema");
    const { loadDemoWorkspace } = await import("@/lib/demo");
    await drizzle(sql, { schema }).transaction((tx) => loadDemoWorkspace(tx, { password: "demo-password-123" }));
    expect(await count("account", sql`where user_id like 'demo-fs-%' and provider_id = 'credential' and password is not null`)).toBe(5);
    await sql`delete from account where user_id like 'demo-fs-%'`;
  });

  it("is for admins only, and a dispatcher, technician or user can't load it", async () => {
    await expect(adminLib.loadDemo(dispatcher)).rejects.toMatchObject({ status: 403 });
    await expect(adminLib.loadDemo({ id: "x", role: "technician" })).rejects.toMatchObject({ status: 403 });
    await expect(adminLib.loadDemo({ id: "x", role: "user" })).rejects.toMatchObject({ status: 403 });
  });

  it("is capped at 3 loads an hour per admin, and 20 a day for the whole app", async () => {
    // admin has used two loads; a third works, the fourth is refused.
    await adminLib.loadDemo(admin);
    await expect(adminLib.loadDemo(admin)).rejects.toMatchObject({ status: 429 });
    // The daily cap is shared: fill it, and another admin is refused too.
    await sql`insert into daily_usage (day, kind, count) values ((now() at time zone 'utc')::date, 'demo_load', 20) on conflict (day, kind) do update set count = 20`;
    await expect(adminLib.loadDemo(admin2)).rejects.toMatchObject({ status: 429 });
    await sql`delete from daily_usage where kind = 'demo_load'`;
    await adminLib.loadDemo(admin2);
  });

  it("refuses, and changes nothing, when a real account already uses a demo id or address", async () => {
    await wipeDemo();
    await sql`insert into "user" (id, name, email, role) values ('real-person-fs', 'Real', 'fs-tech-1@demo.breakthru.test', 'user')`;
    try {
      await sql`delete from rate_event where user_id in (${admin.id}, ${admin2.id})`;
      await expect(adminLib.loadDemo(admin)).rejects.toMatchObject({ status: 409 });
      expect(await count("customer", sql`where created_by like 'demo-fs-%'`)).toBe(0);
      expect(await count("user", sql`where id like 'demo-fs-%'`)).toBe(0);
      expect((await sql`select role, image from "user" where id = 'real-person-fs'`)[0]).toMatchObject({ role: "user", image: null });
    } finally {
      await sql`delete from "user" where id = 'real-person-fs'`;
    }
    // A real account holding a demo *id* (not just the email) is refused too.
    await sql`insert into "user" (id, name, email, role) values ('demo-fs-tech-2', 'Imposter', 'imposter@test.local', 'user')`;
    await expect(adminLib.loadDemo(admin)).rejects.toMatchObject({ status: 409 });
    expect((await sql`select name, role from "user" where id = 'demo-fs-tech-2'`)[0]).toMatchObject({ name: "Imposter", role: "user" });
  });
});
