/**
 * The dispatcher's two server actions, the write path the board and /jobs/new use (smoke posts to the API instead).
 *
 * The case that matters: the server applies the write and the response is lost. The client retries with the same op id
 * and must be told the truth — one job, one assignment, no "someone else changed this job".
 */
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { clean, setup, testDatabaseUrl, type TestUser } from "./fs-helpers";

const P = "jact";

const holder: { user: TestUser | null } = { user: null };

vi.mock("@/lib/auth/session", () => ({
  requireRole: async () => {
    if (!holder.user) throw new Error("no test user");
    return holder.user;
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { redirectUrl: url });
  },
}));

const redirectUrl = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (err) {
    if (err && typeof err === "object" && "redirectUrl" in err) return String((err as { redirectUrl: string }).redirectUrl);
    throw err;
  }
  throw new Error("expected a redirect");
};

function formOf(values: Record<string, string>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(values)) form.set(key, value);
  return form;
}

describe.skipIf(!testDatabaseUrl)("dispatcher server actions (Postgres)", () => {
  let sql: postgres.Sql;
  let d1: TestUser, t1: TestUser, t2: TestUser;
  let jobs: typeof import("@/lib/service-jobs");
  let customers: typeof import("@/lib/customers");
  let createJobAction: typeof import("@/app/jobs/actions").createJobAction;
  let assignJobAction: typeof import("@/app/board/actions").assignJobAction;
  let updateJobAction: typeof import("@/app/jobs/[id]/actions").updateJobAction;
  let customerId: string, siteId: string;

  const TZ = "America/Chicago";
  // 2026-11-17 07:00–08:00 in Chicago, a day the board doesn't show by default.
  const START = "2026-11-17T07:00";
  const END = "2026-11-17T08:00";

  const assignedEvents = async (jobId: string) =>
    Number((await sql`select count(*) as n from job_event where job_id = ${jobId} and kind = 'assigned'`)[0].n);

  beforeAll(async () => {
    const s = await setup(P, { d1: "dispatcher", t1: "technician", t2: "technician" });
    sql = s.sql;
    ({ d1, t1, t2 } = s.users);
    holder.user = d1;
    jobs = await import("@/lib/service-jobs");
    customers = await import("@/lib/customers");
    ({ createJobAction } = await import("@/app/jobs/actions"));
    ({ assignJobAction } = await import("@/app/board/actions"));
    ({ updateJobAction } = await import("@/app/jobs/[id]/actions"));
    customerId = (await customers.createCustomer(d1, { name: "Co", phone: "1" })).customer.id;
    siteId = (await customers.createSite(d1, customerId, { label: "S", address: "A" })).site.id;
  });
  afterAll(async () => {
    await clean(sql, P);
    await sql.end();
  });

  const newJobForm = (extra: Record<string, string> = {}) =>
    formOf({ customerId, siteId, title: "Boiler", description: "", priority: "normal", assigneeId: "", scheduledStart: "", scheduledEnd: "", tz: TZ, ...extra });

  const countJobs = async (title: string) =>
    Number((await sql`select count(*) as n from service_job where created_by = ${d1.id} and title = ${title}`)[0].n);

  describe("createJobAction", () => {
    it("creates a job and sends the dispatcher to the board on the job's own day", async () => {
      const url = await redirectUrl(createJobAction({}, newJobForm({ title: "Created", assigneeId: t1.id, scheduledStart: START, scheduledEnd: END })));
      expect(url).toContain("/board?date=2026-11-17");
      expect(await countJobs("Created")).toBe(1);
    });

    it("replays one op id to one job when the response is lost", async () => {
      const form = newJobForm({ title: "Replayed", clientOpId: crypto.randomUUID() });
      await redirectUrl(createJobAction({}, form));
      await redirectUrl(createJobAction({}, form)); // the retry the user never saw answered
      expect(await countJobs("Replayed")).toBe(1);
    });

    it("refuses a clock time the spring-forward skips", async () => {
      const state = await createJobAction({}, newJobForm({ title: "Gap", assigneeId: t1.id, scheduledStart: "2026-03-08T02:30", scheduledEnd: "2026-03-08T03:30" }));
      expect(state.error).toMatch(/doesn't exist on this date/);
      expect(await countJobs("Gap")).toBe(0);
    });
  });

  describe("assignJobAction", () => {
    const assignForm = (job: { id: string; version: number }, extra: Record<string, string> = {}) =>
      formOf({ jobId: job.id, version: String(job.version), tz: TZ, assigneeId: t1.id, scheduledStart: START, scheduledEnd: END, ...extra });

    const unassigned = async (title = "To assign") => (await jobs.createJob(d1, { customerId, siteId, title })).job;

    it("assigns an unassigned job", async () => {
      const job = await unassigned();
      expect(await assignJobAction({}, assignForm(job))).toEqual({ ok: true });
      const after = await jobs.getJob(d1, job.id);
      expect(after).toMatchObject({ status: "scheduled", assignee: { id: t1.id }, version: job.version + 1 });
      expect(after.scheduledStart).toBe("2026-11-17T13:00:00.000Z");
    });

    it("answers a replayed op id with the assignment that already landed, not a conflict", async () => {
      const job = await unassigned("Lost response");
      const form = assignForm(job, { clientOpId: crypto.randomUUID() });
      expect(await assignJobAction({}, form)).toEqual({ ok: true });
      const applied = await jobs.getJob(d1, job.id);

      // The same form again: the version in it is stale now, because the client's own write is what moved it.
      expect(await assignJobAction({}, form)).toEqual({ ok: true });
      expect(await assignJobAction({}, form)).toEqual({ ok: true });

      const after = await jobs.getJob(d1, job.id);
      expect(after.version).toBe(applied.version);
      expect(after.updatedAt).toBe(applied.updatedAt);
      expect(await assignedEvents(job.id)).toBe(1);
    });

    it("without an op id, a stale version still conflicts — and says the board was refreshed, which the form now does", async () => {
      const job = await unassigned("No op id");
      const form = assignForm(job);
      expect(await assignJobAction({}, form)).toEqual({ ok: true });
      const state = await assignJobAction({}, form);
      expect(state).toMatchObject({ conflict: true });
      expect(state.error).toMatch(/refreshed/);
      expect(state.error).not.toMatch(/Someone else/);
      expect(await assignedEvents(job.id)).toBe(1);
    });

    it("a genuine conflict is still a conflict: someone else moved the job first", async () => {
      const job = await unassigned("Two dispatchers");
      await jobs.updateJob(d1, job.id, { op: "assign", version: job.version, assigneeId: t2.id, scheduledStart: "2026-11-17T13:00:00.000Z", scheduledEnd: "2026-11-17T14:00:00.000Z" });
      const state = await assignJobAction({}, assignForm(job, { clientOpId: crypto.randomUUID() }));
      expect(state).toMatchObject({ conflict: true });
      expect((await jobs.getJob(d1, job.id)).assignee?.id).toBe(t2.id);
    });

    it("refuses a clock time the spring-forward skips", async () => {
      const job = await unassigned("Gap assign");
      const state = await assignJobAction({}, assignForm(job, { scheduledStart: "2026-03-08T02:30", scheduledEnd: "2026-03-08T03:30" }));
      expect(state.error).toMatch(/doesn't exist on this date/);
      expect((await jobs.getJob(d1, job.id)).status).toBe("unassigned");
    });

    it("answers a replay after the assignment was undone with ok and the job as it stands now", async () => {
      // Deliberate: the op id says "this request happened", and it did. Re-applying it would resurrect an assignment
      // the dispatcher took back, which is worse than a retry being told its request got through.
      const job = await unassigned("Undone");
      const form = assignForm(job, { clientOpId: crypto.randomUUID() });
      expect(await assignJobAction({}, form)).toEqual({ ok: true });
      const assigned = await jobs.getJob(d1, job.id);
      await jobs.updateJob(d1, job.id, { op: "unassign", version: assigned.version });

      expect(await assignJobAction({}, form)).toEqual({ ok: true });
      const after = await jobs.getJob(d1, job.id);
      expect(after.status).toBe("unassigned");
      expect(after.assignee).toBeNull();
      expect(await assignedEvents(job.id)).toBe(1);
    });

    it("rejects an op id already used for another job", async () => {
      const first = await unassigned("Op id reuse A");
      const second = await unassigned("Op id reuse B");
      const opId = crypto.randomUUID();
      expect(await assignJobAction({}, assignForm(first, { clientOpId: opId }))).toEqual({ ok: true });
      const state = await assignJobAction({}, assignForm(second, { clientOpId: opId }));
      expect(state.error).toMatch(/operation id/);
      expect((await jobs.getJob(d1, second.id)).status).toBe("unassigned");
    });

    it("rejects an op id this actor already used for an event of another kind", async () => {
      // The unique index is (actor_id, op_id) across every kind, so a reused id can't become a second event; the
      // lookup answers it as a different request instead of running into the index.
      const job = await unassigned("Op id across kinds");
      const opId = crypto.randomUUID();
      await sql`insert into job_event (job_id, actor_id, kind, op_id) values (${job.id}, ${d1.id}, 'rescheduled', ${opId})`;
      const state = await assignJobAction({}, assignForm(job, { clientOpId: opId }));
      expect(state.error).toMatch(/operation id/);
      expect((await jobs.getJob(d1, job.id)).status).toBe("unassigned");
      expect(await assignedEvents(job.id)).toBe(0);
    });
  });

  /**
   * The job detail page's own assign form. Same defect, same fix as the board (above): without an op id a retry after
   * a lost response is told "someone else changed this", about its own write. `AssignForm` sends the window already in
   * ISO (`prepareWindow` runs before the op id is chosen), so these forms do too.
   */
  describe("updateJobAction (assign on the job detail page)", () => {
    const ISO_START = "2026-11-17T13:00:00.000Z";
    const ISO_END = "2026-11-17T14:00:00.000Z";

    const detailAssignForm = (job: { id: string; version: number }, extra: Record<string, string> = {}) =>
      formOf({ id: job.id, customerId, version: String(job.version), op: "assign", assigneeId: t1.id, scheduledStart: ISO_START, scheduledEnd: ISO_END, ...extra });

    const unassigned = async (title: string) => (await jobs.createJob(d1, { customerId, siteId, title })).job;

    it("assigns an unassigned job", async () => {
      const job = await unassigned("Detail assign");
      expect(await updateJobAction({}, detailAssignForm(job))).toEqual({ ok: true });
      expect(await jobs.getJob(d1, job.id)).toMatchObject({ status: "scheduled", assignee: { id: t1.id }, version: job.version + 1 });
    });

    it("answers a replayed op id with the assignment that already landed, not a conflict", async () => {
      const job = await unassigned("Detail lost response");
      const form = detailAssignForm(job, { clientOpId: crypto.randomUUID() });
      expect(await updateJobAction({}, form)).toEqual({ ok: true });
      const applied = await jobs.getJob(d1, job.id);

      // The same form again, exactly as the browser resends it: its version is stale only because its own write landed.
      expect(await updateJobAction({}, form)).toEqual({ ok: true });
      expect(await updateJobAction({}, form)).toEqual({ ok: true });

      const after = await jobs.getJob(d1, job.id);
      expect(after.version).toBe(applied.version);
      expect(after.updatedAt).toBe(applied.updatedAt);
      expect(after.assignee?.id).toBe(t1.id);
      expect(await assignedEvents(job.id)).toBe(1);
    });

    it("without an op id, the retry is the false conflict this fix removes", async () => {
      const job = await unassigned("Detail no op id");
      const form = detailAssignForm(job);
      expect(await updateJobAction({}, form)).toEqual({ ok: true });
      const state = await updateJobAction({}, form);
      expect(state).toMatchObject({ conflict: true });
      expect(state.error).toMatch(/Someone else changed this/);
      expect(await assignedEvents(job.id)).toBe(1);
    });

    it("a genuine conflict is still a conflict: someone else moved the job first", async () => {
      const job = await unassigned("Detail two dispatchers");
      await jobs.updateJob(d1, job.id, { op: "assign", version: job.version, assigneeId: t2.id, scheduledStart: ISO_START, scheduledEnd: ISO_END });
      const state = await updateJobAction({}, detailAssignForm(job, { clientOpId: crypto.randomUUID() }));
      expect(state).toMatchObject({ conflict: true });
      expect(state.error).toMatch(/Someone else changed this/);
      expect((await jobs.getJob(d1, job.id)).assignee?.id).toBe(t2.id);
      expect(await assignedEvents(job.id)).toBe(1);
    });

    it("rejects an op id already used for another job", async () => {
      const first = await unassigned("Detail op reuse A");
      const second = await unassigned("Detail op reuse B");
      const opId = crypto.randomUUID();
      expect(await updateJobAction({}, detailAssignForm(first, { clientOpId: opId }))).toEqual({ ok: true });
      const state = await updateJobAction({}, detailAssignForm(second, { clientOpId: opId }));
      expect(state.error).toMatch(/operation id/);
      expect((await jobs.getJob(d1, second.id)).status).toBe("unassigned");
      expect(await assignedEvents(second.id)).toBe(0);
    });
  });
});
