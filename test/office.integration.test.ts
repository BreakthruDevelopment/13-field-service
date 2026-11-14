/**
 * Dispatcher customers, job detail and work-order review against Postgres.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkInView, parseCoord } from "@/lib/check-in";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("office customers and job detail (Postgres)", () => {
  let sql: postgres.Sql;
  const dispatcher = { id: "jd-dispatcher", role: "dispatcher" as const };
  const other = { id: "jd-other", role: "dispatcher" as const };
  const tech = { id: "jd-tech", role: "technician" as const };
  const tech2 = { id: "jd-tech-2", role: "technician" as const };
  const plain = { id: "jd-plain", role: "user" as const };
  const admin = { id: "jd-admin", role: "admin" as const };
  const limited = { id: "jd-limited", role: "dispatcher" as const };
  const long = "C".repeat(60);

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    sql = postgres(url!, { max: 1 });
    await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
    await cleanup();
    for (const u of [dispatcher, other, tech, tech2, plain, admin, limited]) {
      await sql`insert into "user" (id, name, email, role) values (${u.id}, ${u.id}, ${u.id + "@test.local"}, ${u.role})`;
    }
  });

  afterAll(async () => {
    await cleanup();
    await sql.end();
  });

  async function cleanup() {
    await sql`delete from work_order_line where work_order_id in (
      select id from work_order where job_id in (
        select id from service_job where created_by like 'jd-%' or assignee_id like 'jd-%'
      )
    )`;
    await sql`delete from work_order where job_id in (
      select id from service_job where created_by like 'jd-%' or assignee_id like 'jd-%'
    )`;
    await sql`delete from job_event where actor_id like 'jd-%' or job_id in (
      select id from service_job where created_by like 'jd-%' or assignee_id like 'jd-%'
    )`;
    await sql`delete from job_note where author_id like 'jd-%' or job_id in (
      select id from service_job where created_by like 'jd-%' or assignee_id like 'jd-%'
    )`;
    await sql`delete from service_job where created_by like 'jd-%' or assignee_id like 'jd-%'`;
    await sql`delete from site where customer_id in (select id from customer where created_by like 'jd-%')`;
    await sql`delete from customer where created_by like 'jd-%'`;
    await sql`delete from part where sku like 'JD-%'`;
    await sql`delete from rate_event where user_id like 'jd-%'`;
    await sql`delete from "user" where id like 'jd-%'`;
  }

  async function seedPlace(name = "Ada Plumbing") {
    const customerId = crypto.randomUUID();
    const siteId = crypto.randomUUID();
    await sql`insert into customer (id, created_by, name, phone, notes) values (${customerId}, ${dispatcher.id}, ${name}, '555-0100', '')`;
    await sql`insert into site (id, customer_id, label, address, lat, lng, access_notes) values (
      ${siteId}, ${customerId}, 'Main house', ${"B".repeat(60)}, '30.00000', '-97.00000', 'Gate code 12'
    )`;
    return { customerId, siteId };
  }

  async function seedJob(
    place: { customerId: string; siteId: string },
    overrides: { status?: string; assigneeId?: string | null; completed?: boolean; title?: string } = {},
  ) {
    const id = crypto.randomUUID();
    const status = overrides.status ?? "unassigned";
    const assignee = overrides.assigneeId === undefined ? null : overrides.assigneeId;
    const windowed = status !== "unassigned";
    await sql`insert into service_job (
      id, customer_id, site_id, created_by, assignee_id, title, description, priority, status,
      scheduled_start, scheduled_end, completed_at
    ) values (
      ${id}, ${place.customerId}, ${place.siteId}, ${dispatcher.id}, ${assignee},
      ${overrides.title ?? "Kitchen sink leaking under cabinet"}, 'Water under the cabinet.', 'high', ${status},
      ${windowed ? "2026-11-14T15:00:00.000Z" : null}, ${windowed ? "2026-11-14T17:00:00.000Z" : null},
      ${overrides.completed ? "2026-11-14T18:00:00.000Z" : null}
    )`;
    return id;
  }

  it("refuses anyone who is not a dispatcher, including an admin and the assigned technician", async () => {
    const { getCustomer, listCustomers } = await import("@/lib/customers");
    const { approveWorkOrder, getJobDetail, listTechnicians } = await import("@/lib/job-detail");
    const place = await seedPlace("Hidden Co");
    const jobId = await seedJob(place, { status: "scheduled", assigneeId: tech.id });
    for (const actor of [plain, tech, admin]) {
      await expect(listCustomers(actor)).rejects.toMatchObject({ status: 404 });
      await expect(getCustomer(actor, place.customerId)).rejects.toMatchObject({ status: 404 });
      await expect(getJobDetail(actor, jobId)).rejects.toMatchObject({ status: 404 });
      await expect(listTechnicians(actor)).rejects.toMatchObject({ status: 404 });
      await expect(approveWorkOrder(actor, { jobId, version: 1 })).rejects.toMatchObject({ status: 404 });
    }
    await expect(getJobDetail(dispatcher, "not-a-uuid")).rejects.toMatchObject({ name: "ZodError" });
  });

  it("creates one customer for a repeated op, rejects NUL, and refuses a stale edit", async () => {
    const { createCustomer, listCustomers, updateCustomer } = await import("@/lib/customers");
    const clientOpId = crypto.randomUUID();
    const input = { name: long, phone: "555-0199", email: "ada@example.test", notes: "Gate", clientOpId };
    const first = await createCustomer(dispatcher, input);
    const renamed = { ...input, name: "Should not replace" };
    const again = await createCustomer(dispatcher, renamed);
    const parallel = await Promise.all([1, 2, 3].map(() => createCustomer(dispatcher, input)));
    expect(again.id).toBe(first.id);
    expect(again.name).toBe(long);
    expect(parallel.every((row) => row.id === first.id)).toBe(true);
    const rows = await sql`select id from customer where created_by = ${dispatcher.id} and name = ${long}`;
    expect(rows).toHaveLength(1);

    const visible = await listCustomers(other, { q: long.slice(0, 20) });
    expect(visible.rows.some((row) => row.id === first.id)).toBe(true);

    await expect(createCustomer(dispatcher, { ...input, clientOpId: crypto.randomUUID(), name: "bad\0name" })).rejects.toMatchObject({
      name: "ZodError",
    });
    await expect(createCustomer(dispatcher, { ...input, clientOpId: crypto.randomUUID(), email: "not-an-email" })).rejects.toMatchObject({
      name: "ZodError",
    });

    const updated = await updateCustomer(dispatcher, { ...input, id: first.id, version: 1, name: "Ada Plumbing" });
    expect(updated.version).toBe(2);
    expect(updated.name).toBe("Ada Plumbing");
    const replay = await updateCustomer(dispatcher, { ...input, id: first.id, version: 1, name: "Ada Plumbing" });
    expect(replay.version).toBe(2);
    await expect(updateCustomer(dispatcher, { ...input, id: first.id, version: 1, name: "Someone else" })).rejects.toMatchObject({
      status: 409,
    });
    const [stored] = await sql`select name, version from customer where id = ${first.id}`;
    expect(stored).toMatchObject({ name: "Ada Plumbing", version: 2 });
  });

  it("adds a site once, stores coordinates, and rejects a one-sided point", async () => {
    const { createCustomer, createSite, updateSite } = await import("@/lib/customers");
    const clientOpId = crypto.randomUUID();
    const customer = await createCustomer(dispatcher, {
      name: "Site Owner",
      phone: "",
      email: "",
      notes: "",
      clientOpId,
    });
    const siteOp = crypto.randomUUID();
    const siteInput = {
      customerId: customer.id,
      clientOpId: siteOp,
      label: "Yard",
      address: long,
      accessNotes: "Dog in the yard",
      lat: "30.2672",
      lng: "-97.7431",
    };
    const site = await createSite(dispatcher, siteInput);
    const again = await createSite(dispatcher, { ...siteInput, label: "Ignore" });
    expect(again.id).toBe(site.id);
    expect(again.label).toBe("Yard");
    expect(Number(site.lat)).toBeCloseTo(30.2672);
    const sites = await sql`select id from site where customer_id = ${customer.id}`;
    expect(sites).toHaveLength(1);

    await expect(createSite(dispatcher, { ...siteInput, clientOpId: crypto.randomUUID(), lat: "30.2", lng: "" })).rejects.toMatchObject({
      name: "ZodError",
    });
    await expect(createSite(dispatcher, { ...siteInput, clientOpId: crypto.randomUUID(), lat: "95", lng: "10" })).rejects.toMatchObject({
      name: "ZodError",
    });
    await expect(createSite(other, { ...siteInput, clientOpId: crypto.randomUUID(), customerId: crypto.randomUUID() })).rejects.toMatchObject({
      status: 404,
    });

    const moved = await updateSite(dispatcher, { ...siteInput, id: site.id, version: site.version, address: "1 Short Street", lat: "", lng: "" });
    expect(moved.version).toBe(site.version + 1);
    expect(moved.lat).toBeNull();
    await expect(updateSite(dispatcher, { ...siteInput, id: site.id, version: site.version, label: "New label" })).rejects.toMatchObject({
      status: 409,
    });
  });

  it("shows the check-in distance and applies assign, reschedule, cancel and reopen", async () => {
    const { getCustomer } = await import("@/lib/customers");
    const { assignJob, cancelJob, getJobDetail, reopenJob, rescheduleJob } = await import("@/lib/job-detail");
    const place = await seedPlace("Check In Co");
    const jobId = await seedJob(place);
    await sql`insert into job_note (job_id, author_id, body, op_id) values (${jobId}, ${tech.id}, ${"N".repeat(60)}, ${crypto.randomUUID()})`;
    await sql`insert into job_event (job_id, actor_id, kind, from_status, to_status, lat, lng, accuracy_m, late) values (
      ${jobId}, ${tech.id}, 'status', 'en_route', 'on_site', '30.0013', '-97.0000', 25, false
    )`;

    const detail = await getJobDetail(dispatcher, jobId);
    expect(detail.customer.name).toBe("Check In Co");
    expect(detail.notes[0]?.body).toBe("N".repeat(60));
    const checkIn = detail.events.find((event) => event.lat);
    expect(checkIn).toBeTruthy();
    expect(
      checkInView({
        lat: parseCoord(checkIn!.lat),
        lng: parseCoord(checkIn!.lng),
        accuracyM: checkIn!.accuracyM,
        late: checkIn!.late,
        siteLat: parseCoord(detail.site.lat),
        siteLng: parseCoord(detail.site.lng),
      })?.summary,
    ).toBe("Checked in ±25 m, 145 m from site");

    const customer = await getCustomer(dispatcher, place.customerId);
    expect(customer.jobs.some((job) => job.id === jobId)).toBe(true);
    expect(customer.sites[0]?.address).toBe("B".repeat(60));

    await expect(assignJob(dispatcher, { jobId, version: 1, assigneeId: plain.id, scheduledStart: "2026-11-14T15:00", scheduledEnd: "2026-11-14T17:00" })).rejects.toMatchObject({ status: 400 });
    await expect(assignJob(dispatcher, { jobId, version: 1, assigneeId: tech.id, scheduledStart: "2026-11-14T08:00", scheduledEnd: "2026-11-14T20:01" })).rejects.toMatchObject({ status: 400 });

    const assigned = await assignJob(dispatcher, {
      jobId,
      version: 1,
      assigneeId: tech.id,
      scheduledStart: "2026-11-14T15:00",
      scheduledEnd: "2026-11-14T17:00",
    });
    expect(assigned.status).toBe("scheduled");
    expect(assigned.version).toBe(2);
    expect(assigned.statusVersion).toBe(2);
    const replayed = await assignJob(dispatcher, {
      jobId,
      version: 1,
      assigneeId: tech.id,
      scheduledStart: "2026-11-14T15:00",
      scheduledEnd: "2026-11-14T17:00",
    });
    expect(replayed.version).toBe(2);

    const moved = await rescheduleJob(dispatcher, {
      jobId,
      version: 2,
      scheduledStart: "2026-11-14T16:00",
      scheduledEnd: "2026-11-14T18:00",
    });
    expect(moved.version).toBe(3);
    expect(moved.statusVersion).toBe(2);

    const reassigned = await assignJob(dispatcher, { jobId, version: 3, assigneeId: tech2.id });
    expect(reassigned.assigneeId).toBe(tech2.id);
    expect(reassigned.statusVersion).toBe(3);

    const cancelled = await cancelJob(dispatcher, { jobId, version: reassigned.version });
    expect(cancelled.status).toBe("cancelled");
    await expect(reopenJob(dispatcher, { jobId, version: cancelled.version })).rejects.toMatchObject({ status: 409 });
    const again = await cancelJob(dispatcher, { jobId, version: 1 });
    expect(again.status).toBe("cancelled");

    const doneId = await seedJob(place, { status: "completed", assigneeId: tech.id, completed: true, title: "Finished call" });
    await expect(cancelJob(dispatcher, { jobId: doneId, version: 1 })).rejects.toMatchObject({ status: 409 });
    const reopened = await reopenJob(dispatcher, { jobId: doneId, version: 1 });
    expect(reopened.status).toBe("scheduled");
    const [done] = await sql`select completed_at, status_version from service_job where id = ${doneId}`;
    expect(done.completed_at).toBeNull();
    expect(done.status_version).toBe(2);

    const heldId = await seedJob(place, { status: "on_hold", assigneeId: tech.id, title: "Waiting on a part" });
    const released = await reopenJob(dispatcher, { jobId: heldId, version: 1 });
    expect(released.status).toBe("scheduled");
  });

  it("approves a submitted work order once, and returns one with a reason", async () => {
    const { approveWorkOrder, getJobDetail, returnWorkOrder } = await import("@/lib/job-detail");
    const place = await seedPlace("Work Order Co");
    const jobId = await seedJob(place, { status: "scheduled", assigneeId: tech.id, title: "Cartridge job" });
    const tasks = JSON.stringify([{ description: "Replace the supply line", state: "to_do" }]);
    const ai = JSON.stringify({ demo: true, dropped: [{ mentioned: "magic pipe", reason: "not_in_notes" }], safety: ["gas smell"] });
    const [order] = await sql<{ id: string }[]>`
      insert into work_order (job_id, status, summary, tasks, follow_up, ai, submitted_by)
      values (${jobId}, 'submitted', 'Replaced the cartridge.', ${tasks}::jsonb, 'Bring a braided line.', ${ai}::jsonb, ${tech.id})
      returning id
    `;
    const [part] = await sql<{ id: string }[]>`insert into part (sku, name, unit) values ('JD-CART', 'Cartridge', 'each') returning id`;
    await sql`insert into work_order_line (work_order_id, part_id, mentioned, qty, unit, used, source, flags, position)
      values (${order!.id}, ${part!.id}, 'cartridge', 1.00, 'each', 'used', 'ai', ${["qty_check"]}, 0)`;
    await sql`insert into work_order_line (work_order_id, mentioned, qty, unit, used, source, flags, position)
      values (${order!.id}, ${long}, 1.00, 'each', 'needed', 'ai', ${["unknown_part"]}, 1)`;

    const detail = await getJobDetail(dispatcher, jobId);
    expect(detail.workOrder?.status).toBe("submitted");
    expect(detail.workOrder?.demo).toBe(true);
    expect(detail.workOrder?.dropped).toEqual([{ mentioned: "magic pipe", reason: "not_in_notes" }]);
    expect(detail.workOrder?.safety).toEqual(["gas smell"]);
    expect(detail.workOrder?.tasks[0]?.description).toBe("Replace the supply line");
    expect(detail.workOrder?.lines.map((line) => line.sku)).toEqual(["JD-CART", null]);
    expect(detail.workOrder?.lines[1]?.mentioned).toBe(long);
    expect(detail.workOrder?.submittedByName).toBe(tech.id);

    const [first, second] = await Promise.all([
      approveWorkOrder(dispatcher, { jobId, version: 1 }),
      approveWorkOrder(other, { jobId, version: 1 }),
    ]);
    expect(first.status).toBe("approved");
    expect(second.status).toBe("approved");
    const [stored] = await sql`select version, status from work_order where id = ${order!.id}`;
    expect(stored).toMatchObject({ version: 2, status: "approved" });
    await expect(returnWorkOrder(dispatcher, { jobId, version: 2, reason: "Need a quantity." })).rejects.toMatchObject({ status: 409 });
    const approved = await getJobDetail(dispatcher, jobId);
    expect(approved.workOrder?.approvedByName).toBeTruthy();

    const returnJob = await seedJob(place, { status: "scheduled", assigneeId: tech.id, title: "Return me" });
    await sql`insert into work_order (job_id, status, summary, tasks, submitted_by) values (
      ${returnJob}, 'submitted', 'Draft summary', '[]'::jsonb, ${tech.id}
    )`;
    await expect(returnWorkOrder(dispatcher, { jobId: returnJob, version: 1, reason: "bad\0reason" })).rejects.toMatchObject({ name: "ZodError" });
    await expect(returnWorkOrder(dispatcher, { jobId: returnJob, version: 1, reason: "  " })).rejects.toMatchObject({ name: "ZodError" });
    const returned = await returnWorkOrder(dispatcher, { jobId: returnJob, version: 1, reason: "The quantity looks high." });
    expect(returned).toMatchObject({ status: "returned", version: 2 });
    const replay = await returnWorkOrder(dispatcher, { jobId: returnJob, version: 1, reason: "The quantity looks high." });
    expect(replay.version).toBe(2);
    await expect(approveWorkOrder(dispatcher, { jobId: returnJob, version: 1 })).rejects.toMatchObject({ status: 409 });

    const draftJob = await seedJob(place, { status: "scheduled", assigneeId: tech.id, title: "Still a draft" });
    await sql`insert into work_order (job_id, status, summary, tasks) values (${draftJob}, 'draft', 'Not submitted', '[]'::jsonb)`;
    await expect(approveWorkOrder(dispatcher, { jobId: draftJob, version: 1 })).rejects.toMatchObject({ status: 409 });
    await expect(getJobDetail(dispatcher, crypto.randomUUID())).rejects.toMatchObject({ status: 404 });
  });

  it("stops a dispatcher after 300 writes in an hour", async () => {
    const { createCustomer } = await import("@/lib/customers");
    await sql`insert into rate_event (user_id, kind) select ${limited.id}, 'api_write' from generate_series(1, 300)`;
    await expect(
      createCustomer(limited, { name: "Too many", phone: "", email: "", notes: "", clientOpId: crypto.randomUUID() }),
    ).rejects.toMatchObject({ status: 429 });
  });
});
