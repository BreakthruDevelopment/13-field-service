/**
 * Dispatcher schedule data against Postgres: who may write, idempotent create, and the board day.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("dispatch schedule (Postgres)", () => {
  let sql: postgres.Sql;
  const dispatcher = { id: "dj-dispatcher", role: "dispatcher" as const };
  const other = { id: "dj-other", role: "dispatcher" as const };
  const tech = { id: "dj-tech", role: "technician" as const };
  const plain = { id: "dj-plain", role: "user" as const };
  const admin = { id: "dj-admin", role: "admin" as const };
  const long = "A".repeat(60);

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    sql = postgres(url!, { max: 1 });
    await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
    await cleanup();
    for (const u of [dispatcher, other, tech, plain, admin]) {
      await sql`insert into "user" (id, name, email, role) values (${u.id}, ${u.id}, ${u.id + "@test.local"}, ${u.role})`;
    }
  });

  afterAll(async () => {
    await cleanup();
    await sql.end();
  });

  async function cleanup() {
    await sql`delete from service_job where created_by like 'dj-%' or assignee_id like 'dj-%'`;
    await sql`delete from site where customer_id in (select id from customer where created_by like 'dj-%')`;
    await sql`delete from customer where created_by like 'dj-%'`;
    await sql`delete from rate_event where user_id like 'dj-%'`;
    await sql`delete from "user" where id like 'dj-%'`;
  }

  function jobInput(overrides: Record<string, unknown> = {}) {
    const clientOpId = crypto.randomUUID();
    return {
      clientOpId,
      customer: { name: "Ada Plumbing", phone: "555-0100", email: "ada@example.test", notes: "", clientOpId },
      site: { label: "Main house", address: "1 Long Street", accessNotes: "Gate code 12", clientOpId },
      title: "Kitchen sink leaking under cabinet",
      description: "Water under the cabinet.",
      priority: "high" as const,
      assigneeId: tech.id,
      scheduledStart: "2026-11-14T15:00:00.000Z",
      scheduledEnd: "2026-11-14T17:00:00.000Z",
      ...overrides,
    };
  }

  it("refuses anyone who is not a dispatcher, including an admin", async () => {
    const { createDispatchJob, listBoard, listDispatchJobs } = await import("@/lib/dispatch");
    for (const actor of [plain, tech, admin]) {
      await expect(listDispatchJobs(actor)).rejects.toMatchObject({ status: 404 });
      await expect(listBoard(actor, "2026-11-14")).rejects.toMatchObject({ status: 404 });
      await expect(createDispatchJob(actor, jobInput())).rejects.toMatchObject({ status: 404 });
    }
  });

  it("creates one assigned job, shows it on that technician's day, and replays the same op", async () => {
    const { createDispatchJob, listBoard, listDispatchJobs } = await import("@/lib/dispatch");
    const input = jobInput({ title: long, site: { label: "Main", address: "B".repeat(60), accessNotes: "", clientOpId: "" } });
    const siteOp = crypto.randomUUID();
    input.site = { label: "Main", address: "B".repeat(60), accessNotes: "", clientOpId: siteOp };
    input.customer = { ...input.customer, clientOpId: input.clientOpId as string };

    const first = await createDispatchJob(dispatcher, input);
    const again = await createDispatchJob(dispatcher, input);
    const parallel = await Promise.all([1, 2, 3].map(() => createDispatchJob(dispatcher, input)));
    expect(again.id).toBe(first.id);
    expect(parallel.every((row) => row.id === first.id)).toBe(true);
    expect(first.status).toBe("scheduled");
    expect(first.assigneeId).toBe(tech.id);
    expect(first.title).toBe(long);

    const customers = await sql`select id from customer where created_by = ${dispatcher.id} and name = 'Ada Plumbing'`;
    expect(customers).toHaveLength(1);

    const board = await listBoard(dispatcher, "2026-11-14");
    const lane = board.lanes.find((item) => item.technicianId === tech.id);
    expect(lane?.jobs.some((job) => job.id === first.id)).toBe(true);
    expect(board.unassigned.some((job) => job.id === first.id)).toBe(false);

    const nextDay = await listBoard(dispatcher, "2026-11-15");
    expect(nextDay.lanes.find((item) => item.technicianId === tech.id)?.jobs.some((job) => job.id === first.id)).toBe(false);

    const listed = await listDispatchJobs(other, { q: long.slice(0, 20) });
    expect(listed.some((job) => job.id === first.id)).toBe(true);
    expect(await listDispatchJobs(dispatcher, { assignee: tech.id, status: "scheduled", priority: "high" })).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: first.id })]),
    );
  });

  it("keeps an unassigned job in the tray on every day", async () => {
    const { createDispatchJob, listBoard } = await import("@/lib/dispatch");
    const clientOpId = crypto.randomUUID();
    const created = await createDispatchJob(dispatcher, {
      clientOpId,
      customer: { name: "Unassigned Co", phone: "", email: "", notes: "", clientOpId },
      site: { label: "Yard", address: "9 Road", accessNotes: "", clientOpId },
      title: "No technician yet",
      description: "",
      priority: "normal",
    });
    expect(created.status).toBe("unassigned");
    expect(created.assigneeId).toBeNull();
    for (const day of ["2026-11-14", "2026-12-01"]) {
      const board = await listBoard(dispatcher, day);
      expect(board.unassigned.some((job) => job.id === created.id)).toBe(true);
    }
  });

  it("rejects a NUL byte, a window over 12 hours, a non-technician, and a site from another customer", async () => {
    const { createDispatchJob } = await import("@/lib/dispatch");
    await expect(createDispatchJob(dispatcher, jobInput({ title: "bad\0title" }))).rejects.toMatchObject({ name: "ZodError" });

    const tooLong = jobInput({
      scheduledStart: "2026-11-14T08:00:00.000Z",
      scheduledEnd: "2026-11-14T20:01:00.000Z",
    });
    await expect(createDispatchJob(dispatcher, tooLong)).rejects.toMatchObject({ name: "ZodError" });

    const exact = await createDispatchJob(
      dispatcher,
      jobInput({
        scheduledStart: "2026-11-14T08:00:00.000Z",
        scheduledEnd: "2026-11-14T20:00:00.000Z",
      }),
    );
    expect(exact.status).toBe("scheduled");

    await expect(createDispatchJob(dispatcher, jobInput({ assigneeId: plain.id }))).rejects.toMatchObject({ status: 400 });

    const customerOp = crypto.randomUUID();
    const owned = await createDispatchJob(dispatcher, {
      clientOpId: customerOp,
      customer: { name: "Site Owner", phone: "", email: "", notes: "", clientOpId: customerOp },
      site: { label: "Only site", address: "1 Way", accessNotes: "", clientOpId: customerOp },
      title: "Owned site",
      description: "",
    });
    const otherOp = crypto.randomUUID();
    const otherCustomer = await createDispatchJob(dispatcher, {
      clientOpId: otherOp,
      customer: { name: "Someone else", phone: "", email: "", notes: "", clientOpId: otherOp },
      site: { label: "Other site", address: "2 Way", accessNotes: "", clientOpId: otherOp },
      title: "Other customer",
      description: "",
    });
    const mismatch = crypto.randomUUID();
    await expect(
      createDispatchJob(dispatcher, {
        clientOpId: mismatch,
        customerId: otherCustomer.customerId,
        siteId: owned.siteId,
        title: "Wrong site",
        description: "",
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
