/**
 * Technician snapshot, sync, and work-order rules against Postgres.
 * User ids use the techit- prefix so the items suite's it-% cleanup cannot collide.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

type Actor = { id: string; role: "user" | "technician" | "dispatcher" | "admin" };

describe.skipIf(!url)("technician sync (Postgres)", () => {
  let sql: postgres.Sql;
  const tech: Actor = { id: "techit-tech", role: "technician" };
  const other: Actor = { id: "techit-other", role: "technician" };
  const dispatcher: Actor = { id: "techit-disp", role: "dispatcher" };
  const waiting: Actor = { id: "techit-user", role: "user" };
  const office: Actor = { id: "techit-office", role: "user" };
  const people = [tech, other, dispatcher, waiting, office];

  let customerId = "";
  let siteId = "";
  const jobs: Record<string, string> = {};

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
    await cleanup();
    for (const person of people) {
      await sql`insert into "user" (id, name, email, role) values (${person.id}, ${person.id}, ${person.id + "@test.local"}, ${person.role})`;
    }
    const [customer] = await sql<{ id: string }[]>`
      insert into customer (created_by, name, phone, email, notes)
      values (${office.id}, 'Harbor Cafe', '555-0100', 'planted-secret@example.test', 'private-office-note')
      returning id
    `;
    customerId = customer!.id;
    const [site] = await sql<{ id: string }[]>`
      insert into site (customer_id, label, address, lat, lng, access_notes)
      values (${customerId}, 'Front counter', '1 Pier Street', 40.12345, -73.98765, 'Ring the side bell')
      returning id
    `;
    siteId = site!.id;

    const start = new Date();
    const far = new Date(start.getTime() + 20 * 24 * 60 * 60 * 1000);
    const recent = new Date(start.getTime() - 24 * 60 * 60 * 1000);
    const old = new Date(start.getTime() - 10 * 24 * 60 * 60 * 1000);

    async function addJob(key: string, assignee: string, status: string, scheduled: Date | null, completed: Date | null) {
      const scheduledEnd = scheduled ? new Date(scheduled.getTime() + 2 * 60 * 60 * 1000).toISOString() : null;
      const scheduledStart = scheduled ? scheduled.toISOString() : null;
      const completedAt = completed ? completed.toISOString() : null;
      const [row] = await sql<{ id: string }[]>`
        insert into service_job (customer_id, site_id, created_by, assignee_id, title, status, scheduled_start, scheduled_end, completed_at)
        values (
          ${customerId}, ${siteId}, ${office.id}, ${assignee}, ${key}, ${status},
          ${scheduledStart}, ${scheduledEnd}, ${completedAt}
        )
        returning id
      `;
      jobs[key] = row!.id;
    }

    await addJob("today", tech.id, "scheduled", start, null);
    await addJob("etag", tech.id, "scheduled", start, null);
    await addJob("replay", tech.id, "scheduled", start, null);
    await addJob("stale", tech.id, "scheduled", start, null);
    await addJob("reschedule", tech.id, "scheduled", start, null);
    await addJob("reassign", tech.id, "scheduled", start, null);
    await addJob("depends", tech.id, "en_route", start, null);
    await addJob("complete", tech.id, "on_site", start, null);
    await addJob("note-then", tech.id, "on_site", start, null);
    await addJob("budget", tech.id, "scheduled", start, null);
    await addJob("locate", tech.id, "scheduled", start, null);
    await addJob("locate-bad", tech.id, "scheduled", start, null);
    await addJob("cap", tech.id, "scheduled", start, null);
    await addJob("transition", tech.id, "scheduled", start, null);
    await addJob("draft", tech.id, "scheduled", start, null);
    await addJob("returned", tech.id, "scheduled", start, null);
    await addJob("approved", tech.id, "scheduled", start, null);
    await addJob("recent-done", tech.id, "completed", start, recent);
    await addJob("old-done", tech.id, "completed", start, old);
    await addJob("far", tech.id, "scheduled", far, null);
    await addJob("theirs", other.id, "scheduled", start, null);

    await sql`
      update service_job set status_version = 2, status = 'en_route'
      where id = ${jobs.depends}
    `;
    await sql`
      insert into job_note (job_id, author_id, body, client_at, op_id)
      select ${jobs.cap}, ${tech.id}, 'seed', now(), gen_random_uuid()
      from generate_series(1, 200)
    `;
  });

  afterAll(async () => {
    await cleanup();
    await sql.end();
  });

  async function cleanup() {
    await sql`delete from sync_op where actor_id like 'techit-%'`;
    await sql`delete from job_note where author_id like 'techit-%'`;
    await sql`delete from job_event where actor_id like 'techit-%'`;
    await sql`delete from work_order_line where work_order_id in (
      select id from work_order where job_id in (
        select id from service_job where created_by like 'techit-%' or assignee_id like 'techit-%'
      )
    )`;
    await sql`delete from work_order where job_id in (
      select id from service_job where created_by like 'techit-%' or assignee_id like 'techit-%'
    )`;
    await sql`delete from service_job where created_by like 'techit-%' or assignee_id like 'techit-%'`;
    await sql`delete from site where customer_id in (select id from customer where created_by like 'techit-%')`;
    await sql`delete from customer where created_by like 'techit-%'`;
    await sql`delete from rate_event where user_id like 'techit-%'`;
    await sql`delete from "user" where id like 'techit-%'`;
  }

  function note(jobId: string, body: string, opId = crypto.randomUUID()) {
    return { opId, kind: "note.add" as const, jobId, body, clientAt: new Date().toISOString() };
  }

  function status(
    jobId: string,
    to: "en_route" | "on_site" | "on_hold" | "completed",
    baseStatusVersion: number,
    extra: { opId?: string; dependsOn?: string | null; location?: { lat: number; lng: number; accuracyM: number; capturedAt: string } } = {},
  ) {
    return {
      opId: extra.opId ?? crypto.randomUUID(),
      kind: "status.set" as const,
      jobId,
      to,
      baseStatusVersion,
      dependsOn: extra.dependsOn ?? null,
      clientAt: new Date().toISOString(),
      ...(extra.location ? { location: extra.location } : {}),
    };
  }

  it("refuses a snapshot and a sync to anyone who is not a technician", async () => {
    const { applySync, loadSnapshot } = await import("@/lib/tech-sync");
    await expect(loadSnapshot(dispatcher)).rejects.toMatchObject({ status: 403 });
    await expect(loadSnapshot(waiting)).rejects.toMatchObject({ status: 403 });
    await expect(loadSnapshot({ id: tech.id, role: "admin" })).rejects.toMatchObject({ status: 403 });
    await expect(applySync(dispatcher, { ops: [] })).rejects.toMatchObject({ status: 403 });
    await expect(applySync(tech, { ops: [note(jobs.today, "bad\0byte")] })).rejects.toMatchObject({ name: "ZodError" });
  });

  it("returns only this technician's jobs and hides the customer's email and office notes", async () => {
    const { loadSnapshot } = await import("@/lib/tech-sync");
    const first = await loadSnapshot(tech);
    const again = await loadSnapshot(tech);
    expect(again.etag).toBe(first.etag);
    expect(again.body.serverTime).not.toBe("");
    const encoded = JSON.stringify(first.body.jobs);
    expect(encoded).not.toContain("planted-secret@example.test");
    expect(encoded).not.toContain("private-office-note");
    expect(encoded).not.toContain(jobs.theirs);
    expect(encoded).not.toContain(jobs.far);
    expect(encoded).not.toContain(jobs["old-done"]);
    expect(encoded).toContain(jobs.today);
    expect(encoded).toContain(jobs["recent-done"]);
    expect(first.body.jobs.find((job) => job.id === jobs.today)?.accessNotes).toBe("Ring the side bell");

    const op = note(jobs.etag, "etag note");
    const { applySync } = await import("@/lib/tech-sync");
    const synced = await applySync(tech, { ops: [op] });
    expect(synced.results[0]).toMatchObject({ outcome: "applied", opId: op.opId });
    const after = await loadSnapshot(tech);
    expect(after.etag).not.toBe(first.etag);
    expect(after.body.jobs.find((job) => job.id === jobs.etag)?.notes.map((item) => item.body)).toContain("etag note");
  });

  it("replays the same op, rejects a reused id, and does not store the note text", async () => {
    const { applySync } = await import("@/lib/tech-sync");
    const op = note(jobs.replay, "first wording");
    const applied = await applySync(tech, { deviceId: "phone-1", ops: [op] });
    expect(applied.results[0]?.outcome).toBe("applied");
    const replayed = await applySync(tech, { deviceId: "phone-1", ops: [op] });
    expect(replayed.results[0]).toMatchObject({ outcome: "replayed", code: null, opId: op.opId });
    const [{ notes }] = await sql<{ notes: number }[]>`select count(*)::int as notes from job_note where job_id = ${jobs.replay}`;
    expect(notes).toBe(1);
    const [ledger] = await sql<{ outcome: string; result: unknown }[]>`
      select outcome, result from sync_op where actor_id = ${tech.id} and op_id = ${op.opId}
    `;
    expect(ledger?.outcome).toBe("applied");
    expect(JSON.stringify(ledger?.result)).not.toContain("first wording");

    const reused = await applySync(tech, { ops: [{ ...op, body: "different wording" }] });
    expect(reused.results[0]).toMatchObject({ outcome: "rejected", code: "op_id_reused" });
    const [{ body }] = await sql<{ body: string }[]>`select body from job_note where job_id = ${jobs.replay}`;
    expect(body).toBe("first wording");
    const [still] = await sql<{ outcome: string }[]>`
      select outcome from sync_op where actor_id = ${tech.id} and op_id = ${op.opId}
    `;
    expect(still?.outcome).toBe("applied");
  });

  it("conflicts on a stale status version and still applies after a reschedule that did not touch status", async () => {
    const { applySync } = await import("@/lib/tech-sync");
    const stale = await applySync(tech, { ops: [status(jobs.stale, "en_route", 9)] });
    expect(stale.results[0]).toMatchObject({
      outcome: "conflict",
      code: "stale_version",
      job: { id: jobs.stale, status: "scheduled", statusVersion: 1 },
    });

    const start = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const end = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    await sql`
      update service_job
      set version = version + 3, scheduled_start = ${start}, scheduled_end = ${end}
      where id = ${jobs.reschedule}
    `;
    const moved = await applySync(tech, { ops: [status(jobs.reschedule, "en_route", 1)] });
    expect(moved.results[0]).toMatchObject({ outcome: "applied", job: { status: "en_route", statusVersion: 2 } });
  });

  it("answers a reassigned or unknown job without a job body", async () => {
    const { applySync } = await import("@/lib/tech-sync");
    await sql`update service_job set assignee_id = ${other.id} where id = ${jobs.reassign}`;
    const missing = crypto.randomUUID();
    const batch = await applySync(tech, {
      ops: [
        note(jobs.reassign, "left behind"),
        status(jobs.reassign, "en_route", 1),
        note(jobs.theirs, "not mine"),
        status(missing, "en_route", 1),
      ],
    });
    expect(batch.results[0]).toMatchObject({ outcome: "rejected", code: "not_assigned" });
    expect(batch.results[0]?.job ?? null).toBeNull();
    expect(batch.results[1]).toMatchObject({ outcome: "conflict", code: "not_assigned" });
    expect(batch.results[1]?.job ?? null).toBeNull();
    expect(batch.results[2]).toMatchObject({ outcome: "rejected", code: "not_assigned" });
    expect(batch.results[3]).toMatchObject({ outcome: "conflict", code: "not_assigned" });
    const [{ notes }] = await sql<{ notes: number }[]>`select count(*)::int as notes from job_note where job_id = ${jobs.reassign}`;
    expect(notes).toBe(0);
  });

  it("checks dependsOn before the status version", async () => {
    const { applySync } = await import("@/lib/tech-sync");
    const firstId = crypto.randomUUID();
    const batch = await applySync(tech, {
      ops: [
        status(jobs.depends, "on_site", 1, { opId: firstId }),
        status(jobs.depends, "on_site", 2, { dependsOn: firstId }),
      ],
    });
    expect(batch.results[0]).toMatchObject({ outcome: "conflict", code: "stale_version" });
    expect(batch.results[1]).toMatchObject({ outcome: "conflict", code: "depends_on", job: { statusVersion: 2 } });
    const [{ statusVersion }] = await sql<{ statusVersion: number }[]>`
      select status_version as "statusVersion" from service_job where id = ${jobs.depends}
    `;
    expect(statusVersion).toBe(2);
  });

  it("requires a note to complete, and accepts a note earlier in the same batch", async () => {
    const { applySync } = await import("@/lib/tech-sync");
    const blocked = await applySync(tech, { ops: [status(jobs.complete, "completed", 1)] });
    expect(blocked.results[0]).toMatchObject({ outcome: "rejected", code: "note_required" });
    const [{ status: still }] = await sql<{ status: string }[]>`select status from service_job where id = ${jobs.complete}`;
    expect(still).toBe("on_site");

    const done = await applySync(tech, {
      ops: [note(jobs["note-then"], "Finished the filter"), status(jobs["note-then"], "completed", 1)],
    });
    expect(done.results.map((result) => result.outcome)).toEqual(["applied", "applied"]);
    const [{ status: completed }] = await sql<{ status: string }[]>`select status from service_job where id = ${jobs["note-then"]}`;
    expect(completed).toBe("completed");
  });

  it("defers the rest of a batch once the time budget is spent, then applies it on the next send", async () => {
    const { applySync } = await import("@/lib/tech-sync");
    let ticks = 0;
    const second = note(jobs.budget, "second");
    const deferred = await applySync(
      tech,
      { ops: [note(jobs.budget, "first"), second] },
      { budgetMs: 8_000, clockMs: () => (ticks++ === 0 ? 0 : 10_000) },
    );
    expect(deferred.results.map((result) => result.outcome)).toEqual(["applied", "deferred"]);
    const [{ notes }] = await sql<{ notes: number }[]>`select count(*)::int as notes from job_note where job_id = ${jobs.budget}`;
    expect(notes).toBe(1);
    const resent = await applySync(tech, { ops: [second] });
    expect(resent.results[0]?.outcome).toBe("applied");
    const [{ notes: after }] = await sql<{ notes: number }[]>`select count(*)::int as notes from job_note where job_id = ${jobs.budget}`;
    expect(after).toBe(2);
  });

  it("stores a check-in location only on arrival, rounded to four decimals", async () => {
    const { applySync, loadSnapshot } = await import("@/lib/tech-sync");
    const denied = await applySync(tech, {
      ops: [
        status(jobs["locate-bad"], "en_route", 1, {
          location: { lat: 40.1, lng: -73.9, accuracyM: 10, capturedAt: new Date().toISOString() },
        }),
      ],
    });
    expect(denied.results[0]).toMatchObject({ outcome: "rejected", code: "location_not_allowed" });
    const [{ events }] = await sql<{ events: number }[]>`select count(*)::int as events from job_event where job_id = ${jobs["locate-bad"]}`;
    expect(events).toBe(0);

    const arrived = await applySync(tech, {
      ops: [
        status(jobs.locate, "on_site", 1, {
          location: { lat: 40.123456, lng: -73.987654, accuracyM: 25.4, capturedAt: "2000-01-01T00:00:00.000Z" },
        }),
      ],
    });
    expect(arrived.results[0]).toMatchObject({ outcome: "applied", job: { status: "on_site" } });
    const [event] = await sql<{ lat: string; lng: string; accuracy: number; late: boolean }[]>`
      select lat::text as lat, lng::text as lng, accuracy_m as accuracy, late
      from job_event where job_id = ${jobs.locate}
    `;
    expect(Number(event?.lat).toFixed(4)).toBe("40.1235");
    expect(Number(event?.lng).toFixed(4)).toBe("-73.9877");
    expect(event?.accuracy).toBe(25);
    expect(event?.late).toBe(true);
    const snapshot = await loadSnapshot(tech);
    const view = snapshot.body.jobs.find((job) => job.id === jobs.locate)?.checkIn;
    expect(view?.summary).toContain("Checked in");
    expect(view?.summary).toContain("from site");
    expect(view?.summary).toContain("reported late");
    expect(view?.deviceReported).toBe(true);
    expect(view?.osmUrl).toContain("openstreetmap.org");
  });

  it("rejects the 201st note", async () => {
    const { applySync } = await import("@/lib/tech-sync");
    const capped = await applySync(tech, { ops: [note(jobs.cap, "one more")] });
    expect(capped.results[0]).toMatchObject({ outcome: "rejected", code: "too_many_notes" });
    const [{ notes }] = await sql<{ notes: number }[]>`select count(*)::int as notes from job_note where job_id = ${jobs.cap}`;
    expect(notes).toBe(200);
  });

  it("rejects a status the technician cannot make from the current one", async () => {
    const { applySync } = await import("@/lib/tech-sync");
    const bad = await applySync(tech, { ops: [status(jobs.transition, "completed", 1)] });
    expect(bad.results[0]).toMatchObject({ outcome: "conflict", code: "bad_transition", job: { status: "scheduled" } });
  });

  it("saves a human work order, conflicts on a stale version, and locks submitted and approved copies", async () => {
    const { getWorkOrder, saveWorkOrder } = await import("@/lib/work-order");
    expect(await getWorkOrder(tech, jobs.draft)).toBeNull();
    await expect(getWorkOrder(dispatcher, jobs.draft)).rejects.toMatchObject({ status: 403 });
    await expect(getWorkOrder(tech, jobs.theirs)).rejects.toMatchObject({ status: 404 });
    await expect(getWorkOrder(tech, crypto.randomUUID())).rejects.toMatchObject({ status: 404 });

    const draft = await saveWorkOrder(tech, jobs.draft, {
      version: 1,
      summary: "Replaced the filter",
      tasks: [{ description: "Shut the valve", state: "done" }],
      followUp: "Call if it drips",
      lines: [{ mentioned: "Filter", qty: 1.5, unit: "ft", used: "used" }],
      submit: false,
    });
    expect(draft).toMatchObject({ status: "draft", version: 1, summary: "Replaced the filter" });
    expect(draft.lines[0]).toMatchObject({ qty: 1.5, unit: "ft", used: "used" });
    const [stored] = await sql<{ qty: string; source: string }[]>`
      select qty::text as qty, source from work_order_line
      where work_order_id = (select id from work_order where job_id = ${jobs.draft})
    `;
    expect(stored?.qty).toBe("1.50");
    expect(stored?.source).toBe("human");

    const saved = await saveWorkOrder(tech, jobs.draft, {
      version: draft.version,
      summary: draft.summary,
      tasks: [],
      followUp: draft.followUp,
      lines: [],
      submit: false,
    });
    expect(saved.version).toBe(2);
    expect(saved.lines).toHaveLength(0);
    await expect(
      saveWorkOrder(tech, jobs.draft, { version: 1, summary: "old", tasks: [], followUp: "", lines: [], submit: false }),
    ).rejects.toMatchObject({ status: 409, message: "This work order changed. Load it again." });

    await expect(
      saveWorkOrder(tech, jobs.draft, { version: saved.version, summary: "   ", tasks: [], followUp: "", lines: [], submit: true }),
    ).rejects.toMatchObject({ status: 400, message: "Add a summary before submitting." });

    const submitted = await saveWorkOrder(tech, jobs.draft, {
      version: saved.version,
      summary: "Replaced the filter",
      tasks: [],
      followUp: "",
      lines: [],
      submit: true,
    });
    expect(submitted).toMatchObject({ status: "submitted", version: 3 });
    await expect(
      saveWorkOrder(tech, jobs.draft, { version: 3, summary: "nope", tasks: [], followUp: "", lines: [], submit: false }),
    ).rejects.toMatchObject({ status: 409, message: "This work order is with the office and can't be edited." });

    await sql`
      insert into work_order (job_id, status, summary, version, return_reason)
      values (${jobs.returned}, 'returned', 'Look again', 1, 'Need a photo')
    `;
    const returned = await saveWorkOrder(tech, jobs.returned, {
      version: 1,
      summary: "Look again",
      tasks: [],
      followUp: "",
      lines: [],
      submit: false,
    });
    expect(returned).toMatchObject({ status: "returned", version: 2, returnReason: "Need a photo" });
    const sent = await saveWorkOrder(tech, jobs.returned, {
      version: returned.version,
      summary: returned.summary,
      tasks: [],
      followUp: "",
      lines: [],
      submit: true,
    });
    expect(sent.status).toBe("submitted");

    await sql`
      insert into work_order (job_id, status, summary, version)
      values (${jobs.approved}, 'approved', 'Done', 1)
    `;
    await expect(
      saveWorkOrder(tech, jobs.approved, { version: 1, summary: "Done", tasks: [], followUp: "", lines: [], submit: false }),
    ).rejects.toMatchObject({ status: 409, message: "This work order is with the office and can't be edited." });
  });
});
