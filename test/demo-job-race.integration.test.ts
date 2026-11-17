/**
 * Issue #13: `createJob` against a customer the demo reload is replacing.
 *
 * The reload deletes every demo customer (sites, jobs, notes and events cascade) and inserts a fresh set, so a create
 * that read the site a moment earlier can reach its insert with the parent row already gone. The interleavings here are
 * forced, not raced: a control connection holds a lock the create must take, so the two transactions meet at a chosen
 * point every run.
 *
 * The invariant: a create tolerates a reload mid-flight. It either completes (and the reload, which waits for it,
 * cascades the new job away) or answers 404 because the customer it named is gone. A foreign-key violation (500) and a
 * lock cycle (deadlock, answered as a 409 "retry") are both failures, and the reload itself is never the one refused.
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clean, setup, testDatabaseUrl, uuid, type TestUser } from "./fs-helpers";

const P = "djr";

describe.skipIf(!testDatabaseUrl)("createJob while the demo workspace is reloaded (Postgres)", () => {
  let sql: postgres.Sql;
  /** A second pool, pinned to one connection, so a transaction can be held open across statements. */
  let ctl: postgres.Sql;
  let admin: TestUser, dispatcher: TestUser;
  let adminLib: typeof import("@/lib/admin");
  let jobs: typeof import("@/lib/service-jobs");
  let customersLib: typeof import("@/lib/customers");
  let errorInfo: typeof import("@/lib/http").errorInfo;

  /** 200 for anything that worked, otherwise the HTTP status the route would answer (500 for an unmapped error). */
  const status = (p: Promise<unknown>) => p.then(() => 200, (e: unknown) => errorInfo(e).status);

  const wipeDemo = async () => {
    await sql`delete from service_job where created_by like 'demo-fs-%' or assignee_id like 'demo-fs-%'`;
    await sql`delete from customer where created_by like 'demo-fs-%'`;
    await sql`delete from part where created_by like 'demo-fs-%'`;
    await sql`delete from job_event where actor_id like 'demo-fs-%'`;
    await sql`delete from job_note where author_id like 'demo-fs-%'`;
    await sql`delete from "user" where id like 'demo-fs-%' or email like 'fs-%@demo.breakthru.test'`;
  };

  /** Hold `name`'s advisory lock on the control connection until `release()`; anything that takes it then queues up. */
  async function hold(name: string) {
    await ctl.unsafe("begin");
    await ctl.unsafe("select pg_advisory_xact_lock(hashtextextended($1, 0))", [name]);
    return () => ctl.unsafe("commit");
  }

  /**
   * Wait until `n` connections are blocked on a lock of any kind (an advisory lock, or a row another transaction
   * holds). Counting connections rather than lock rows keeps this honest for both: one waiter can queue for a tuple
   * lock and the holder's transaction id at the same time.
   */
  async function waitForWaiters(n: number) {
    for (let i = 0; i < 200; i++) {
      const [{ waiting }] = await sql`
        select count(distinct l.pid)::int as waiting
        from pg_locks l join pg_stat_activity a on a.pid = l.pid
        where not l.granted and a.datname = current_database()`;
      if (waiting >= n) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`no ${n} connection(s) blocked on a lock after 10s`);
  }

  beforeAll(async () => {
    const s = await setup(P, { admin: "admin", dispatcher: "dispatcher" });
    sql = s.sql;
    ({ admin, dispatcher } = s.users);
    ctl = postgres(testDatabaseUrl!, { max: 1, onnotice: () => {} });
    await wipeDemo();
    adminLib = await import("@/lib/admin");
    jobs = await import("@/lib/service-jobs");
    customersLib = await import("@/lib/customers");
    ({ errorInfo } = await import("@/lib/http"));
  });

  afterAll(async () => {
    await wipeDemo();
    await clean(sql, P);
    await ctl.end();
    await sql.end();
  });

  it("a create whose customer is deleted after the create started is a 404, never a 500", async () => {
    const customerId = (await customersLib.createCustomer(dispatcher, { name: "Doomed Co", phone: "555-0199" })).customer.id;
    const siteId = (await customersLib.createSite(dispatcher, customerId, { label: "Yard", address: "1 Gone Street" })).site.id;

    // The create blocks on its own write-rate lock, before it has read or locked anything.
    const release = await hold(`rate:api_write:${dispatcher.id}`);
    const create = status(jobs.createJob(dispatcher, { customerId, siteId, title: "Create against a deleted customer", clientOpId: uuid() }));
    await waitForWaiters(1);
    await sql`delete from customer where id = ${customerId}`;
    await release();

    expect(await create).toBe(404);
  });

  it("a delete committing between the parent check and the insert does not reach the foreign key", async () => {
    const customerId = (await customersLib.createCustomer(dispatcher, { name: "Racing Co", phone: "555-0198" })).customer.id;
    const siteId = (await customersLib.createSite(dispatcher, customerId, { label: "Shop", address: "2 Race Street" })).site.id;

    // The open-jobs cap lock is taken after the customer and site are checked and before the job row is inserted:
    // holding it parks the create in exactly the window the demo reload's delete used to slip through.
    const release = await hold("cap:open_jobs");
    const create = status(jobs.createJob(dispatcher, { customerId, siteId, title: "Create racing a delete", clientOpId: uuid() }));
    await waitForWaiters(1);

    // The delete waits for the create's lock on the customer row; without that lock it commits here and the insert
    // below fails the foreign key (23503, an unmapped 500).
    const deleted = sql`delete from customer where id = ${customerId}`.then(
      () => "deleted" as const,
      (e: unknown) => e,
    );
    await release();

    expect(await create).toBe(200);
    expect(await deleted).toBe("deleted");
    const [{ n }] = await sql`select count(*)::int as n from service_job where created_by = ${dispatcher.id}`;
    expect(n).toBe(0); // the delete cascaded the new job away, which is what a reload does to a demo job
  });

  it("a demo reload starting while a create is in flight: both finish, no 500 and no deadlock", async () => {
    await adminLib.loadDemo(admin, { clientOpId: uuid() });
    const [demoRow] = await sql`
      select c.id as customer_id, s.id as site_id
      from customer c join site s on s.customer_id = c.id
      where c.created_by = 'demo-fs-dispatcher-1'
      order by s.id limit 1`;

    const release = await hold("cap:open_jobs");
    const create = status(
      jobs.createJob(dispatcher, { customerId: demoRow.customer_id, siteId: demoRow.site_id, title: "Create during a reload", clientOpId: uuid() }),
    );
    await waitForWaiters(1);
    // The reload deletes the demo customers, then queues for the same cap lock at the end of its transaction: wait
    // until both are parked there, so releasing the lock lets them race from the same starting line.
    const reload = status(adminLib.loadDemo(admin, { clientOpId: uuid() }));
    await waitForWaiters(2);
    await release();

    const [createCode, reloadCode] = await Promise.all([create, reload]);
    expect(reloadCode).toBe(200);
    expect([200, 404]).toContain(createCode);
    const [{ n }] = await sql`select count(*)::int as n from customer where created_by = 'demo-fs-dispatcher-1'`;
    expect(n).toBe(8); // one copy of the demo workspace, as the reload promises
  }, 30_000);
});
