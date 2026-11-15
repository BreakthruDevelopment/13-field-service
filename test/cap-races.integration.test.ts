/**
 * Every "count, then add" cap, raced: each parallel burst comes from DIFFERENT users (a per-user lock can't help) and
 * lands exactly one over the last free slot. Exactly one request may win. Caps: parts, open jobs (create and reopen),
 * notes per job, and the demo loader.
 */
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clean, setup, testDatabaseUrl, uuid, window, type TestUser } from "./fs-helpers";

const P = "cap";
const N = 6;

describe.skipIf(!testDatabaseUrl)("caps hold under parallel requests (Postgres)", () => {
  let sql: postgres.Sql;
  let disp: TestUser[];
  let admins: TestUser[];
  let tech: TestUser;
  let jobs: typeof import("@/lib/service-jobs");
  let customers: typeof import("@/lib/customers");
  let parts: typeof import("@/lib/parts");
  let adminLib: typeof import("@/lib/admin");
  let caps: typeof import("@/lib/caps");
  let errorInfo: typeof import("@/lib/http").errorInfo;
  let customerId: string, siteId: string;

  const status = (p: Promise<unknown>) => p.then(() => 200, (e: unknown) => errorInfo(e).status);
  const wins = (codes: number[]) => codes.filter((c) => c === 200).length;
  const openCount = async () => (await sql`select count(*)::int as n from service_job where status in ('unassigned','scheduled','en_route','on_site','on_hold')`)[0].n as number;

  beforeAll(async () => {
    const people: Record<string, "dispatcher" | "admin" | "technician"> = {};
    people.t0 = "technician";
    for (let i = 0; i < N; i++) people[`d${i}`] = "dispatcher";
    people.a0 = "admin";
    people.a1 = "admin";
    const s = await setup(P, people);
    sql = s.sql;
    disp = Array.from({ length: N }, (_, i) => s.users[`d${i}`]);
    admins = [s.users.a0, s.users.a1];
    tech = s.users.t0;
    jobs = await import("@/lib/service-jobs");
    customers = await import("@/lib/customers");
    parts = await import("@/lib/parts");
    adminLib = await import("@/lib/admin");
    caps = await import("@/lib/caps");
    ({ errorInfo } = await import("@/lib/http"));
    customerId = (await customers.createCustomer(disp[0], { name: "Co", phone: "1" })).customer.id;
    siteId = (await customers.createSite(disp[0], customerId, { label: "S", address: "A" })).site.id;
  });
  afterAll(async () => {
    caps.capLimits.parts = caps.MAX_PARTS;
    caps.capLimits.openJobs = caps.MAX_OPEN_JOBS;
    await sql`delete from part where created_by like ${`${P}-%`}`;
    await clean(sql, P);
    await sql.end();
  });

  it("parts: parallel creates at one slot below the cap admit exactly one", async () => {
    const [{ n }] = await sql`select count(*)::int as n from part`;
    caps.capLimits.parts = n + 1;
    const codes = await Promise.all(disp.map((d, i) => status(parts.createPart(d, { sku: `CAP-${i}-${Date.now() % 100000}`, name: `Cap part ${i}`, unit: "each" }))));
    expect(wins(codes)).toBe(1);
    expect(codes.filter((c) => c !== 200)).toEqual(Array(N - 1).fill(409));
    const [{ after }] = await sql`select count(*)::int as after from part`;
    expect(after).toBe(n + 1);
    caps.capLimits.parts = caps.MAX_PARTS;
  });

  it("open jobs: parallel creates at one slot below the cap admit exactly one", async () => {
    const open = await openCount();
    caps.capLimits.openJobs = open + 1;
    const codes = await Promise.all(disp.map((d, i) => status(jobs.createJob(d, { customerId, siteId, title: `Race ${i}`, clientOpId: uuid() }))));
    expect(wins(codes)).toBe(1);
    expect(await openCount()).toBe(open + 1);
    caps.capLimits.openJobs = caps.MAX_OPEN_JOBS;
  });

  it("open jobs: parallel reopens of completed jobs, and a create beside them, admit exactly one", async () => {
    const done: { id: string; version: number }[] = [];
    for (let i = 0; i < N; i++) {
      const j = (await jobs.createJob(disp[0], { customerId, siteId, title: `Done ${i}`, assigneeId: tech.id, ...window(), clientOpId: uuid() })).job;
      await sql`update service_job set status = 'completed', completed_at = now() where id = ${j.id}`;
      done.push({ id: j.id, version: (await jobs.getJob(disp[0], j.id)).version });
    }
    const open = await openCount();
    caps.capLimits.openJobs = open + 1;
    const reopens = done.map((j, i) => status(jobs.updateJob(disp[i], j.id, { op: "reopen", version: j.version })));
    const create = status(jobs.createJob(disp[N - 1], { customerId, siteId, title: "Beside", clientOpId: uuid() }));
    const codes = await Promise.all([...reopens, create]);
    expect(wins(codes)).toBe(1);
    expect(await openCount()).toBe(open + 1);
    caps.capLimits.openJobs = caps.MAX_OPEN_JOBS;
  });

  it("notes per job: parallel notes from different dispatchers at 199 admit exactly one", async () => {
    const job = (await jobs.createJob(disp[0], { customerId, siteId, title: "Notes", clientOpId: uuid() })).job;
    await sql`insert into job_note (job_id, author_id, body) select ${job.id}, ${disp[0].id}, 'n' from generate_series(1, ${jobs.MAX_NOTES_PER_JOB - 1})`;
    const codes = await Promise.all(disp.map((d, i) => status(jobs.addJobNote(d, job.id, { body: `race ${i}`, opId: uuid() }))));
    expect(wins(codes)).toBe(1);
    const [{ n }] = await sql`select count(*)::int as n from job_note where job_id = ${job.id}`;
    expect(n).toBe(jobs.MAX_NOTES_PER_JOB);
  });

  it("demo: two admins loading at once both succeed and leave one copy of the workspace", async () => {
    const codes = await Promise.all(admins.map((a) => status(adminLib.loadDemo(a, { clientOpId: uuid() }))));
    expect(codes).toEqual([200, 200]);
    const [{ n }] = await sql`select count(*)::int as n from customer where created_by = 'demo-fs-dispatcher-1'`;
    expect(n).toBe(8);
    await sql`delete from rate_event where user_id like ${`${P}-%`}`;
  });
});
