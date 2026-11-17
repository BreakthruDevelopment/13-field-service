import "server-only";
import { type SQL, and, asc, count, desc, eq, gte, ilike, inArray, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { assertCan, jobScope } from "@/lib/access";
import { type Actor, toRole } from "@/lib/auth/rbac";
import { type Db, db, schema } from "@/lib/db";
import { BadRequestError, ConflictError, NotFoundError, VersionConflictError } from "@/lib/errors";
import {
  ACTIVE_STATUSES,
  FINAL_STATUSES,
  JOB_STATUSES,
  type JobStatus,
  OPEN_STATUSES,
  StatusRuleError,
  isWorkTransition,
  transitionNeedsNote,
} from "@/lib/job-status";
import { clampClientAt, distanceM, locationInput, normalizeLocation } from "@/lib/location";
import { idText, text } from "@/lib/text";
import { CAP_LOCKS, capLimits, MAX_OPEN_JOBS } from "@/lib/caps";
import { advisoryLock, type Tx } from "@/lib/usage";
import { spendRead, writeTx } from "@/lib/write-tx";

/**
 * Jobs: the dispatcher's data layer and the status rules the technician sync (13.2) reuses.
 *
 * Every function takes the acting user and calls `assertCan()`. A technician's queries always carry `jobScope(actor)`
 * (`assignee_id = actor.id`), so another technician's job and a missing job both answer 404.
 * DTOs (`JobSummary`, `JobDetail`) are what the routes return; they never include another role's private fields:
 * customer `email` and `notes` appear only for dispatchers.
 */

type Q = Db | Tx;

export { MAX_OPEN_JOBS };
export const MAX_NOTES_PER_JOB = 200;
export const BOARD_LIMIT = 200;
export const MAX_EVENTS_SHOWN = 500;

const { serviceJob, customer, site, user, jobNote, jobEvent, workOrder } = schema;

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export type JobSummary = {
  id: string;
  number: number;
  title: string;
  priority: (typeof schema.JOB_PRIORITIES)[number];
  status: JobStatus;
  version: number;
  statusVersion: number;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  completedAt: string | null;
  updatedAt: string;
  customer: { id: string; name: string; phone: string };
  site: { id: string; label: string; address: string };
  assignee: { id: string; name: string } | null;
};

export type JobNoteDto = { id: string; authorId: string; authorName: string; body: string; clientAt: string | null; serverAt: string };

export type JobEventDto = {
  id: string;
  kind: (typeof schema.JOB_EVENT_KINDS)[number];
  fromStatus: JobStatus | null;
  toStatus: JobStatus | null;
  actorName: string;
  serverAt: string;
  /** Present on a check-in whose location hasn't been purged. Always "device-reported". */
  checkIn: { lat: number; lng: number; accuracyM: number | null; capturedAt: string | null; late: boolean; distanceFromSiteM: number | null } | null;
};

export type JobDetail = JobSummary & {
  description: string;
  createdAt: string;
  customerDetail: { email: string | null; notes: string } | null; // dispatchers only
  siteDetail: { lat: number | null; lng: number | null; accessNotes: string };
  notes: JobNoteDto[];
  events: JobEventDto[];
  workOrder: { id: string; status: (typeof schema.WORK_ORDER_STATUSES)[number]; version: number } | null;
};

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const num = (v: string | null) => (v === null ? null : Number(v));

const summaryFields = {
  id: serviceJob.id,
  number: serviceJob.number,
  title: serviceJob.title,
  priority: serviceJob.priority,
  status: serviceJob.status,
  version: serviceJob.version,
  statusVersion: serviceJob.statusVersion,
  scheduledStart: serviceJob.scheduledStart,
  scheduledEnd: serviceJob.scheduledEnd,
  completedAt: serviceJob.completedAt,
  updatedAt: serviceJob.updatedAt,
  customerId: customer.id,
  customerName: customer.name,
  customerPhone: customer.phone,
  siteId: site.id,
  siteLabel: site.label,
  siteAddress: site.address,
  assigneeId: serviceJob.assigneeId,
  assigneeName: user.name,
};

type SummaryRow = Awaited<ReturnType<typeof summaryQuery>>[number];

function toSummary(r: SummaryRow): JobSummary {
  return {
    id: r.id,
    number: r.number,
    title: r.title,
    priority: r.priority,
    status: r.status,
    version: r.version,
    statusVersion: r.statusVersion,
    scheduledStart: iso(r.scheduledStart),
    scheduledEnd: iso(r.scheduledEnd),
    completedAt: iso(r.completedAt),
    updatedAt: r.updatedAt.toISOString(),
    customer: { id: r.customerId, name: r.customerName, phone: r.customerPhone },
    site: { id: r.siteId, label: r.siteLabel, address: r.siteAddress },
    assignee: r.assigneeId ? { id: r.assigneeId, name: r.assigneeName ?? "" } : null,
  };
}

function summaryQuery(q: Q) {
  return q
    .select(summaryFields)
    .from(serviceJob)
    .innerJoin(customer, eq(customer.id, serviceJob.customerId))
    .innerJoin(site, eq(site.id, serviceJob.siteId))
    .leftJoin(user, eq(user.id, serviceJob.assigneeId));
}

/** Summaries for the board and lists. The caller has already passed `assertCan` and built a scoped `where`. */
export async function selectSummaries(q: Q, where: SQL | undefined, opts: { limit: number; offset?: number }): Promise<JobSummary[]> {
  const rows = await summaryQuery(q)
    .where(where)
    .orderBy(sql`${serviceJob.scheduledStart} asc nulls last`, desc(serviceJob.number))
    .limit(opts.limit)
    .offset(opts.offset ?? 0);
  return rows.map(toSummary);
}

/** The job as the actor may see it, or `NotFoundError` (a technician asking for someone else's job, or no such job). */
export async function loadJobDetail(q: Q, actor: Actor, id: string): Promise<JobDetail> {
  assertCan(actor, "read", "job");
  const [row] = await q
    .select({
      ...summaryFields,
      description: serviceJob.description,
      createdAt: serviceJob.createdAt,
      customerEmail: customer.email,
      customerNotes: customer.notes,
      siteLat: site.lat,
      siteLng: site.lng,
      siteAccessNotes: site.accessNotes,
    })
    .from(serviceJob)
    .innerJoin(customer, eq(customer.id, serviceJob.customerId))
    .innerJoin(site, eq(site.id, serviceJob.siteId))
    .leftJoin(user, eq(user.id, serviceJob.assigneeId))
    .where(and(eq(serviceJob.id, id), jobScope(actor)));
  if (!row) throw new NotFoundError("Job not found");
  assertCan(actor, "read", "job", { assigneeId: row.assigneeId });

  const notes = await q
    .select({ id: jobNote.id, authorId: jobNote.authorId, authorName: user.name, body: jobNote.body, clientAt: jobNote.clientAt, serverAt: jobNote.serverAt })
    .from(jobNote)
    .innerJoin(user, eq(user.id, jobNote.authorId))
    .where(eq(jobNote.jobId, id))
    .orderBy(asc(jobNote.serverAt), asc(jobNote.id))
    .limit(MAX_NOTES_PER_JOB);
  const events = await q
    .select({
      id: jobEvent.id,
      kind: jobEvent.kind,
      fromStatus: jobEvent.fromStatus,
      toStatus: jobEvent.toStatus,
      actorName: user.name,
      actorId: jobEvent.actorId,
      serverAt: jobEvent.serverAt,
      lat: jobEvent.lat,
      lng: jobEvent.lng,
      accuracyM: jobEvent.accuracyM,
      capturedAt: jobEvent.capturedAt,
      late: jobEvent.late,
    })
    .from(jobEvent)
    .innerJoin(user, eq(user.id, jobEvent.actorId))
    .where(eq(jobEvent.jobId, id))
    // The newest 500, shown oldest first: a long history keeps its recent events.
    .orderBy(desc(jobEvent.serverAt), desc(jobEvent.id))
    .limit(MAX_EVENTS_SHOWN);
  const [wo] = await q
    .select({ id: workOrder.id, status: workOrder.status, version: workOrder.version })
    .from(workOrder)
    .where(eq(workOrder.jobId, id));

  const siteLat = num(row.siteLat);
  const siteLng = num(row.siteLng);
  return {
    ...toSummary(row),
    description: row.description,
    createdAt: row.createdAt.toISOString(),
    customerDetail: actor.role === "dispatcher" ? { email: row.customerEmail, notes: row.customerNotes } : null,
    siteDetail: { lat: siteLat, lng: siteLng, accessNotes: row.siteAccessNotes },
    notes: notes.map((n) => ({ ...n, clientAt: iso(n.clientAt), serverAt: n.serverAt.toISOString() })),
    events: events.reverse().map((e) => {
      const lat = num(e.lat);
      const lng = num(e.lng);
      return {
        id: e.id,
        kind: e.kind,
        fromStatus: e.fromStatus,
        toStatus: e.toStatus,
        actorName: e.actorName,
        serverAt: e.serverAt.toISOString(),
        // A technician sees check-in locations only from their own events; dispatchers see all.
        checkIn:
          lat !== null && lng !== null && (actor.role === "dispatcher" || e.actorId === actor.id)
            ? {
                lat,
                lng,
                accuracyM: e.accuracyM,
                capturedAt: iso(e.capturedAt),
                late: e.late,
                distanceFromSiteM: siteLat !== null && siteLng !== null ? distanceM({ lat, lng }, { lat: siteLat, lng: siteLng }) : null,
              }
            : null,
      };
    }),
    workOrder: wo ?? null,
  };
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const MAX_WINDOW_MS = 12 * 3600_000;
const when = z.iso.datetime({ offset: true }).transform((s) => new Date(s));
const uuid = z.string().uuid();

function windowOk(start: Date, end: Date) {
  return end > start && end.getTime() - start.getTime() <= MAX_WINDOW_MS;
}
const WINDOW_MESSAGE = "scheduledEnd must be after scheduledStart and at most 12 hours later";

export const newJobInput = z
  .strictObject({
    customerId: uuid,
    siteId: uuid,
    title: text(120, { min: 1, minMessage: "Title is required" }),
    description: text(2000).default(""),
    priority: z.enum(schema.JOB_PRIORITIES).default("normal"),
    assigneeId: idText.nullish(),
    scheduledStart: when.nullish(),
    scheduledEnd: when.nullish(),
    /** One id per user intent (`opFor` in `src/lib/client-op.ts`): a retry never creates a second job. */
    clientOpId: uuid.optional(),
  })
  .superRefine((v, ctx) => {
    if (Boolean(v.scheduledStart) !== Boolean(v.scheduledEnd)) {
      ctx.addIssue({ code: "custom", path: ["scheduledEnd"], message: "Give both scheduledStart and scheduledEnd, or neither" });
    } else if (v.scheduledStart && v.scheduledEnd && !windowOk(v.scheduledStart, v.scheduledEnd)) {
      ctx.addIssue({ code: "custom", path: ["scheduledEnd"], message: WINDOW_MESSAGE });
    }
    if (v.assigneeId && !v.scheduledStart) {
      ctx.addIssue({ code: "custom", path: ["scheduledStart"], message: "A scheduled window is required when assigning a technician" });
    }
  });

const windowFields = {
  scheduledStart: when,
  scheduledEnd: when,
};
const refineWindow = <T extends { scheduledStart?: Date | null; scheduledEnd?: Date | null }>(v: T, ctx: z.RefinementCtx) => {
  if (v.scheduledStart && v.scheduledEnd && !windowOk(v.scheduledStart, v.scheduledEnd)) {
    ctx.addIssue({ code: "custom", path: ["scheduledEnd"], message: WINDOW_MESSAGE });
  }
};

const version = z.number().int().min(1);

/** PATCH /api/jobs/:id. Every op carries the `version` the client last saw; a stale one is a 409. */
export const jobPatchInput = z.discriminatedUnion("op", [
  z
    .strictObject({
      op: z.literal("assign"),
      version,
      assigneeId: idText,
      scheduledStart: when.optional(),
      scheduledEnd: when.optional(),
      /**
       * One id per user intent (`opFor` in `src/lib/client-op.ts`). A retry after a lost response replays it and
       * gets the first assignment back instead of a false "someone else changed this job" from the stale version.
       * Enforced by `job_event_actor_op_uidx` on (actor_id, op_id).
       */
      opId: uuid.optional(),
    })
    .superRefine((v, ctx) => {
      if (Boolean(v.scheduledStart) !== Boolean(v.scheduledEnd)) ctx.addIssue({ code: "custom", path: ["scheduledEnd"], message: "Give both scheduledStart and scheduledEnd, or neither" });
      refineWindow(v, ctx);
    }),
  z.strictObject({ op: z.literal("unassign"), version }),
  z.strictObject({ op: z.literal("reschedule"), version, ...windowFields }).superRefine(refineWindow),
  z.strictObject({ op: z.literal("status"), version, to: z.enum(JOB_STATUSES) }),
  z.strictObject({ op: z.literal("cancel"), version }),
  z.strictObject({ op: z.literal("reopen"), version }),
  z.strictObject({
    op: z.literal("edit"),
    version,
    title: text(120, { min: 1, minMessage: "Title is required" }).optional(),
    description: text(2000).optional(),
    priority: z.enum(schema.JOB_PRIORITIES).optional(),
  }),
]);

export const jobListQuery = z.strictObject({
  status: z.enum(JOB_STATUSES).optional(),
  assigneeId: idText.optional(),
  customerId: uuid.optional(),
  q: text(100).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

export const newNoteInput = z.strictObject({
  body: text(2000, { min: 1, minMessage: "Note is empty" }),
  /** One id per note (`opFor`): a retry returns the first note. */
  opId: uuid.optional(),
  clientAt: z.iso.datetime({ offset: true }).optional(),
});

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Dispatchers: all jobs (filterable). Technicians: only their own. `hasMore` means another page exists. */
export async function listJobs(actor: Actor, input: unknown): Promise<{ jobs: JobSummary[]; hasMore: boolean }> {
  assertCan(actor, "read", "job");
  await spendRead(actor);
  const f = jobListQuery.parse(input ?? {});
  const filters: (SQL | undefined)[] = [jobScope(actor)];
  if (f.status) filters.push(eq(serviceJob.status, f.status));
  if (f.assigneeId) filters.push(eq(serviceJob.assigneeId, f.assigneeId));
  if (f.customerId) filters.push(eq(serviceJob.customerId, f.customerId));
  if (f.from) filters.push(gte(serviceJob.scheduledStart, new Date(f.from)));
  if (f.to) filters.push(lt(serviceJob.scheduledStart, new Date(f.to)));
  if (f.q) {
    const like = `%${escapeLike(f.q)}%`;
    filters.push(or(ilike(serviceJob.title, like), ilike(customer.name, like), ilike(site.address, like), ilike(sql`${serviceJob.number}::text`, like)));
  }
  const rows = await selectSummaries(db(), and(...filters), { limit: f.limit + 1, offset: f.offset });
  return { jobs: rows.slice(0, f.limit), hasMore: rows.length > f.limit };
}

export async function getJob(actor: Actor, id: string): Promise<JobDetail> {
  assertCan(actor, "read", "job");
  await spendRead(actor);
  return loadJobDetail(db(), actor, uuid.parse(id));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Whether `id` is an active technician right now. Reads the user row `for share`, so it waits for a concurrent role
 * change (`setUserRole` locks the row `for update`) and an assignment can't slip in beside a revocation.
 */
async function isTechnician(tx: Tx, id: string): Promise<boolean> {
  const [row] = await tx.select({ role: user.role, banned: user.banned }).from(user).where(eq(user.id, id)).for("share");
  return Boolean(row) && !row.banned && toRole(row.role) === "technician";
}

async function requireTechnician(tx: Tx, id: string): Promise<void> {
  if (!(await isTechnician(tx, id))) throw new BadRequestError("Assignee must be a technician");
}

async function insertEvent(
  tx: Tx,
  e: {
    jobId: string;
    actorId: string;
    kind: (typeof schema.JOB_EVENT_KINDS)[number];
    from?: JobStatus | null;
    to?: JobStatus | null;
    location?: ReturnType<typeof normalizeLocation>;
    clientAt?: Date | null;
    opId?: string | null;
  },
) {
  await tx.insert(jobEvent).values({
    jobId: e.jobId,
    actorId: e.actorId,
    kind: e.kind,
    fromStatus: e.from ?? null,
    toStatus: e.to ?? null,
    lat: e.location?.lat ?? null,
    lng: e.location?.lng ?? null,
    accuracyM: e.location?.accuracyM ?? null,
    capturedAt: e.location?.capturedAt ?? null,
    late: e.location?.late ?? false,
    clientAt: e.clientAt ?? null,
    opId: e.opId ?? null,
  });
}

/** `select ... for update` on a job the actor may touch. 404 when it's missing or (for a technician) not theirs. */
export async function lockJob(tx: Tx, actor: Actor, id: string) {
  const [row] = await tx.select().from(serviceJob).where(and(eq(serviceJob.id, id), jobScope(actor))).for("update");
  if (!row) throw new NotFoundError("Job not found");
  return row;
}

type JobRow = typeof serviceJob.$inferSelect;

/** The open-jobs cap, checked under one advisory lock so two creates (or a create and a reopen) can't both take the last slot. */
async function requireOpenCapacity(tx: Tx): Promise<void> {
  await advisoryLock(tx, CAP_LOCKS.openJobs);
  const [{ n }] = await tx.select({ n: count() }).from(serviceJob).where(inArray(serviceJob.status, [...OPEN_STATUSES]));
  if (n >= capLimits.openJobs) throw new ConflictError("Too many open jobs. Complete or cancel some first.");
}

export async function createJob(actor: Actor, input: unknown): Promise<{ job: JobDetail; created: boolean }> {
  assertCan(actor, "create", "job");
  const data = newJobInput.parse(input);
  return writeTx(actor, async (tx) => {
    if (data.clientOpId) {
      const [existing] = await tx
        .select({ id: serviceJob.id })
        .from(serviceJob)
        .where(and(eq(serviceJob.createdBy, actor.id), eq(serviceJob.clientOpId, data.clientOpId)));
      if (existing) return { job: await loadJobDetail(tx, actor, existing.id), created: false };
    }
    if (data.assigneeId) await requireTechnician(tx, data.assigneeId);
    // Lock order (caps.ts): the technician's user row, then this job's customer and site, then the cap lock. `for key
    // share` is the lock the insert's foreign keys would take anyway; taking it here, before the cap lock, decides the
    // race with a demo reload (which deletes its customers, cascading to their sites, and only then takes the cap
    // lock). Either this transaction gets there first and the reload waits for it, or the reload already committed and
    // the row is simply gone: a 404, not the foreign-key violation (23503) this used to become between the check and
    // the insert. Customer before site, the order the reload's cascade takes them in, so no cycle can form.
    const [parentCustomer] = await tx.select({ id: customer.id }).from(customer).where(eq(customer.id, data.customerId)).for("key share");
    if (!parentCustomer) throw new NotFoundError("Customer or site not found");
    const [site_] = await tx
      .select({ id: site.id })
      .from(site)
      .where(and(eq(site.id, data.siteId), eq(site.customerId, data.customerId)))
      .for("key share");
    if (!site_) throw new NotFoundError("Customer or site not found");
    await requireOpenCapacity(tx);

    const status: JobStatus = data.assigneeId ? "scheduled" : "unassigned";
    const [row] = await tx
      .insert(serviceJob)
      .values({
        customerId: data.customerId,
        siteId: data.siteId,
        title: data.title,
        description: data.description,
        priority: data.priority,
        status,
        scheduledStart: data.scheduledStart ?? null,
        scheduledEnd: data.scheduledEnd ?? null,
        assigneeId: data.assigneeId ?? null,
        clientOpId: data.clientOpId ?? null,
        createdBy: actor.id,
      })
      .onConflictDoNothing()
      .returning({ id: serviceJob.id });
    if (!row) {
      // A parallel request with the same op id won the insert: return its job.
      const [existing] = await tx
        .select({ id: serviceJob.id })
        .from(serviceJob)
        .where(and(eq(serviceJob.createdBy, actor.id), eq(serviceJob.clientOpId, data.clientOpId ?? "")));
      if (!existing) throw new ConflictError();
      return { job: await loadJobDetail(tx, actor, existing.id), created: false };
    }
    await insertEvent(tx, { jobId: row.id, actorId: actor.id, kind: "created", to: "unassigned" });
    if (data.assigneeId) await insertEvent(tx, { jobId: row.id, actorId: actor.id, kind: "assigned", from: "unassigned", to: "scheduled" });
    return { job: await loadJobDetail(tx, actor, row.id), created: true };
  });
}

/**
 * The one place a job's status changes, shared by dispatcher PATCHes and the offline sync (13.2). The caller holds the
 * row lock (`lockJob`). Throws `StatusRuleError` (a 409) when the transition isn't allowed or a note is missing. Only a
 * move to `on_site` may carry a location. Bumps `version` and `status_version`.
 */
export async function applyStatusChange(
  tx: Tx,
  actor: Actor,
  job: JobRow,
  to: JobStatus,
  opts: { location?: z.infer<typeof locationInput>; clientAt?: Date | null; opId?: string | null; now?: Date } = {},
): Promise<JobRow> {
  if (FINAL_STATUSES.includes(job.status)) throw new StatusRuleError("job_closed", "This job is closed.");
  if (!isWorkTransition(job.status, to)) throw new StatusRuleError("transition_not_allowed", `A ${job.status.replace("_", " ")} job can't move to ${to.replace("_", " ")}.`);
  if (transitionNeedsNote(to)) {
    const [{ n }] = await tx.select({ n: count() }).from(jobNote).where(eq(jobNote.jobId, job.id));
    if (n < 1) throw new StatusRuleError("note_required", "Add a note about the work before you do that.");
  }
  if (opts.location && to !== "on_site") throw new BadRequestError("A location can only be sent when checking in on site");
  const location = opts.location ? normalizeLocation(opts.location, opts.now) : undefined;
  const now = opts.now ?? new Date();
  const clientAt = clampClientAt(opts.clientAt, now);
  const [updated] = await tx
    .update(serviceJob)
    .set({
      status: to,
      statusVersion: job.statusVersion + 1,
      version: job.version + 1,
      completedAt: to === "completed" ? now : job.completedAt,
      updatedAt: now,
    })
    .where(eq(serviceJob.id, job.id))
    .returning();
  await insertEvent(tx, { jobId: job.id, actorId: actor.id, kind: "status", from: job.status, to, location, clientAt, opId: opts.opId });
  return updated;
}

export async function updateJob(actor: Actor, id: string, input: unknown): Promise<JobDetail> {
  assertCan(actor, "update", "job");
  const jobId = uuid.parse(id);
  const patch = jobPatchInput.parse(input);
  return writeTx(actor, async (tx) => {
    // Lock order is user -> job everywhere (setUserRole locks the technician, then their jobs). An op that will check a
    // technician takes that user's row `for share` BEFORE the job row, or the two can deadlock.
    let techToCheck: string | null = null;
    if (patch.op === "assign") techToCheck = patch.assigneeId;
    if (patch.op === "reopen") {
      const [pre] = await tx.select({ assigneeId: serviceJob.assigneeId }).from(serviceJob).where(and(eq(serviceJob.id, jobId), jobScope(actor)));
      techToCheck = pre?.assigneeId ?? null;
    }
    if (techToCheck) await tx.select({ id: user.id }).from(user).where(eq(user.id, techToCheck)).for("share");
    const job = await lockJob(tx, actor, jobId);
    if (patch.op === "reopen" && job.assigneeId !== techToCheck) throw new ConflictError("The job changed while reopening. Try again.");
    // A replay of an assignment that already landed (the response was lost, the user pressed Assign again) answers with
    // the job AS IT IS NOW. Checked under the row lock and BEFORE the version guard: the client's version is one behind
    // precisely because its own write succeeded, and a conflict there would be a lie it can never escape.
    //
    // The answer is the current job, not the job as the assignment left it, and the replay re-applies nothing. So if
    // the assignment has since been undone (unassigned, cancelled, handed to someone else), the replay still says ok
    // and the caller sees the job standing as it stands. That is the honest answer to what the retry is really asking
    // — "did my request get through?" — and re-applying would quietly resurrect an assignment a dispatcher deliberately
    // took back. The board refreshes on ok, so the dispatcher looks at the current state either way.
    if (patch.op === "assign" && patch.opId) {
      const [done] = await tx
        .select({ jobId: jobEvent.jobId, kind: jobEvent.kind })
        .from(jobEvent)
        .where(and(eq(jobEvent.actorId, actor.id), eq(jobEvent.opId, patch.opId)));
      if (done) {
        // Only this actor's own `assigned` event on this job is a retry of this request. The op id is unique per
        // (actor_id, op_id) across every kind, so anything else is the same id used for something else.
        if (done.jobId !== jobId || done.kind !== "assigned") {
          throw new ConflictError("That operation id was already used for a different assignment.");
        }
        return loadJobDetail(tx, actor, jobId);
      }
    }
    if (job.version !== patch.version) throw new VersionConflictError(await loadJobDetail(tx, actor, jobId));
    const now = new Date();
    const bump = { version: job.version + 1, updatedAt: now };
    const set = (values: Partial<typeof serviceJob.$inferInsert>) => tx.update(serviceJob).set({ ...values, ...bump }).where(eq(serviceJob.id, jobId));

    switch (patch.op) {
      case "assign": {
        if (FINAL_STATUSES.includes(job.status)) throw new ConflictError("A closed job can't be assigned.");
        await requireTechnician(tx, patch.assigneeId);
        const start = patch.scheduledStart ?? job.scheduledStart;
        const end = patch.scheduledEnd ?? job.scheduledEnd;
        if (!start || !end) throw new BadRequestError("A scheduled window is required when assigning a technician");
        const changed = job.assigneeId !== patch.assigneeId || job.status === "unassigned";
        const to: JobStatus = changed ? "scheduled" : job.status;
        await set({ assigneeId: patch.assigneeId, status: to, scheduledStart: start, scheduledEnd: end, statusVersion: job.statusVersion + (changed ? 1 : 0) });
        // The op id lands on the event row, where `job_event_actor_op_uidx` makes a second attempt impossible.
        //
        // This insert has no `onConflictDoNothing`, so it depends on two requests with one op id never racing past the
        // lookup above. They can't: `writeTx` opens every mutation with `consumeRate`, which takes
        // `pg_advisory_xact_lock("rate:api_write:<userId>")` for the whole transaction, and an op id is scoped to
        // (actor_id, op_id) — so any two requests that could share one are the same actor and are already serialised
        // before they reach `lockJob`. Move an assign write off `writeTx` and this becomes a duplicate-key 500: give
        // the insert an `onConflictDoNothing` and re-read, the way `appendNote` does, before you do that.
        await insertEvent(tx, { jobId, actorId: actor.id, kind: "assigned", from: job.status, to, opId: patch.opId });
        break;
      }
      case "unassign": {
        if (!ACTIVE_STATUSES.includes(job.status)) throw new ConflictError("Only a job with a technician can be unassigned.");
        await set({ assigneeId: null, status: "unassigned", statusVersion: job.statusVersion + 1 });
        await insertEvent(tx, { jobId, actorId: actor.id, kind: "unassigned", from: job.status, to: "unassigned" });
        break;
      }
      case "reschedule": {
        if (FINAL_STATUSES.includes(job.status)) throw new ConflictError("A closed job can't be rescheduled.");
        // Does not touch status_version: a queued offline status change still applies.
        await set({ scheduledStart: patch.scheduledStart, scheduledEnd: patch.scheduledEnd });
        await insertEvent(tx, { jobId, actorId: actor.id, kind: "rescheduled", from: job.status, to: job.status });
        break;
      }
      case "status": {
        await applyStatusChange(tx, actor, job, patch.to, { now });
        break;
      }
      case "cancel": {
        if (FINAL_STATUSES.includes(job.status)) throw new ConflictError("This job is already closed.");
        await set({ status: "cancelled", statusVersion: job.statusVersion + 1 });
        await insertEvent(tx, { jobId, actorId: actor.id, kind: "status", from: job.status, to: "cancelled" });
        break;
      }
      case "reopen": {
        if (job.status !== "completed" && job.status !== "on_hold") throw new ConflictError("Only a completed or on-hold job can be reopened.");
        // A completed job becomes open again, so it counts against the same cap createJob enforces.
        if (job.status === "completed") await requireOpenCapacity(tx);
        // The technician may have lost the role since: then the job goes back to the tray instead of to someone who can't see it.
        if (job.assigneeId && (await isTechnician(tx, job.assigneeId))) {
          await set({ status: "scheduled", completedAt: null, statusVersion: job.statusVersion + 1 });
          await insertEvent(tx, { jobId, actorId: actor.id, kind: "status", from: job.status, to: "scheduled" });
        } else {
          await set({ status: "unassigned", assigneeId: null, completedAt: null, statusVersion: job.statusVersion + 1 });
          await insertEvent(tx, { jobId, actorId: actor.id, kind: "unassigned", from: job.status, to: "unassigned" });
        }
        break;
      }
      case "edit": {
        // A closed job's row stays still: an edit would move `updated_at`, which starts the 90-day location clock for cancelled jobs.
        if (FINAL_STATUSES.includes(job.status)) throw new ConflictError("A closed job can't be edited. Reopen it first.");
        const { op: _op, version: _version, ...fields } = patch;
        void _op;
        void _version;
        await set(fields);
        break;
      }
    }
    return loadJobDetail(tx, actor, jobId);
  });
}

/**
 * Append a note to a job the actor can see. Under the job's row lock, so the 200-note cap holds under concurrency.
 * Idempotent per (author, `opId`): a replay returns the first note and writes nothing. Shared with the sync (13.2).
 */
export async function appendNote(
  tx: Tx,
  job: { id: string },
  authorId: string,
  note: { body: string; opId?: string | null; clientAt?: Date | null },
): Promise<{ id: string; created: boolean; reused?: boolean }> {
  // The 200-note cap counts then inserts, so the job row lock is taken here too (re-entrant when the caller already holds it).
  await tx.select({ id: serviceJob.id }).from(serviceJob).where(eq(serviceJob.id, job.id)).for("update");
  if (note.opId) {
    const [existing] = await tx
      .select({ id: jobNote.id, jobId: jobNote.jobId, body: jobNote.body })
      .from(jobNote)
      .where(and(eq(jobNote.authorId, authorId), eq(jobNote.opId, note.opId)));
    // A retry carries the same job and text. The same id on another job or with other text is a different request:
    // `reused` tells the caller not to answer it with the first note.
    if (existing) return { id: existing.id, created: false, ...(existing.jobId !== job.id || existing.body !== note.body ? { reused: true } : {}) };
  }
  const [{ n }] = await tx.select({ n: count() }).from(jobNote).where(eq(jobNote.jobId, job.id));
  if (n >= MAX_NOTES_PER_JOB) throw new ConflictError("This job has the maximum number of notes.");
  const [row] = await tx
    .insert(jobNote)
    .values({ jobId: job.id, authorId, body: note.body, opId: note.opId ?? null, clientAt: clampClientAt(note.clientAt) })
    .onConflictDoNothing()
    .returning({ id: jobNote.id });
  if (row) return { id: row.id, created: true };
  const [existing] = await tx
    .select({ id: jobNote.id, jobId: jobNote.jobId, body: jobNote.body })
    .from(jobNote)
    .where(and(eq(jobNote.authorId, authorId), eq(jobNote.opId, note.opId ?? "")));
  if (!existing) throw new ConflictError();
  return { id: existing.id, created: false, ...(existing.jobId !== job.id || existing.body !== note.body ? { reused: true } : {}) };
}

/** POST /api/jobs/:id/notes: a dispatcher on any job, a technician on their own (offline notes go through /api/sync). */
export async function addJobNote(actor: Actor, id: string, input: unknown): Promise<{ job: JobDetail; created: boolean }> {
  assertCan(actor, "create", "job_note");
  const jobId = uuid.parse(id);
  const data = newNoteInput.parse(input);
  return writeTx(actor, async (tx) => {
    const job = await lockJob(tx, actor, jobId);
    assertCan(actor, "create", "job_note", { assigneeId: job.assigneeId });
    const { created, reused } = await appendNote(tx, job, actor.id, { body: data.body, opId: data.opId, clientAt: data.clientAt ? new Date(data.clientAt) : null });
    if (reused) throw new ConflictError("That operation id was already used for a different note.");
    return { job: await loadJobDetail(tx, actor, jobId), created };
  });
}
