import "server-only";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { type Actor } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import {
  type JobEventKind,
  type JobPriority,
  type ServiceJob,
  type ServiceJobStatus,
  type WorkOrderAi,
  type WorkOrderStatus,
  type WorkOrderTask,
} from "@/lib/db/schema";
import { MAX_WINDOW_MS, parseUtcInstant } from "@/lib/dispatch-view";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/errors";
import { DISPATCH_WRITE_LIMIT, DISPATCH_WRITE_MESSAGE, assertDispatcher } from "@/lib/office";
import { text } from "@/lib/text";
import { type Tx, consumeRate } from "@/lib/usage";

/**
 * Dispatcher job detail: assign, reschedule, cancel, reopen, and work-order review.
 * Technicians and admins get the same 404 as a missing job.
 */

const versionField = z.coerce.number().int().positive();

export const assignJobInput = z.object({
  jobId: z.uuid(),
  version: versionField,
  /** Empty unassigns the job and clears its window. */
  assigneeId: z.string().trim().max(200).default(""),
  scheduledStart: z.string().optional(),
  scheduledEnd: z.string().optional(),
});

export const rescheduleJobInput = z.object({
  jobId: z.uuid(),
  version: versionField,
  scheduledStart: z.string(),
  scheduledEnd: z.string(),
});

export const jobVersionInput = z.object({
  jobId: z.uuid(),
  version: versionField,
});

export const returnWorkOrderInput = jobVersionInput.extend({
  reason: text(300, { min: 1, minMessage: "Say why you're sending this back." }),
});

export type TechnicianOption = { id: string; name: string; email: string };

export type JobChange = {
  id: string;
  version: number;
  statusVersion: number;
  status: ServiceJobStatus;
  assigneeId: string | null;
};

export type JobNoteView = { id: string; body: string; authorName: string; serverAt: Date };

export type JobEventView = {
  id: string;
  kind: JobEventKind;
  fromStatus: ServiceJobStatus | null;
  toStatus: ServiceJobStatus | null;
  actorName: string;
  serverAt: Date;
  lat: string | null;
  lng: string | null;
  accuracyM: number | null;
  late: boolean;
};

export type WorkOrderLineView = {
  id: string;
  mentioned: string;
  qty: string;
  unit: string;
  used: "used" | "needed";
  source: "ai" | "human";
  flags: string[];
  sku: string | null;
  partName: string | null;
};

export type WorkOrderView = {
  id: string;
  status: WorkOrderStatus;
  summary: string;
  tasks: WorkOrderTask[];
  tasksUnreadable: boolean;
  followUp: string | null;
  returnReason: string | null;
  version: number;
  demo: boolean;
  dropped: { mentioned: string; reason: string }[];
  safety: string[];
  aiUnreadable: boolean;
  submittedByName: string | null;
  approvedByName: string | null;
  lines: WorkOrderLineView[];
};

export type JobDetail = {
  id: string;
  number: number;
  title: string;
  description: string;
  priority: JobPriority;
  status: ServiceJobStatus;
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  version: number;
  assigneeId: string | null;
  assigneeName: string | null;
  customer: { id: string; name: string; phone: string };
  site: {
    id: string;
    label: string;
    address: string;
    accessNotes: string;
    lat: string | null;
    lng: string | null;
  };
  notes: JobNoteView[];
  events: JobEventView[];
  workOrder: WorkOrderView | null;
};

const taskList = z.array(z.object({ description: z.string().max(200), state: z.enum(["done", "to_do"]) })).max(12);

const aiRecord = z.object({
  provider: z.string().max(40).optional(),
  demo: z.boolean().optional(),
  dropped: z.array(z.object({ mentioned: z.string().max(200), reason: z.string().max(80) })).max(40).optional(),
  safety: z.array(z.string().max(80)).max(10).optional(),
});

const STALE = "This job changed. Reload and try again.";
const STALE_ORDER = "This work order changed. Reload and try again.";

export async function listTechnicians(actor: Actor): Promise<TechnicianOption[]> {
  assertDispatcher(actor);
  return db()
    .select({ id: schema.user.id, name: schema.user.name, email: schema.user.email })
    .from(schema.user)
    .where(eq(schema.user.role, "technician"))
    .orderBy(asc(schema.user.name))
    .limit(200);
}

function readWindow(startRaw: string | undefined, endRaw: string | undefined): { start: Date; end: Date } | null {
  const startText = startRaw?.trim() ?? "";
  const endText = endRaw?.trim() ?? "";
  if (!startText && !endText) return null;
  const start = startText ? parseUtcInstant(startText) : null;
  const end = endText ? parseUtcInstant(endText) : null;
  if (!start || !end) throw new BadRequestError("Enter a valid start and end.");
  const span = end.getTime() - start.getTime();
  if (span <= 0) throw new BadRequestError("End must be after start.");
  if (span > MAX_WINDOW_MS) throw new BadRequestError("A visit can't be longer than 12 hours.");
  return { start, end };
}

function changeOf(job: Pick<ServiceJob, "id" | "version" | "statusVersion" | "status" | "assigneeId">): JobChange {
  return {
    id: job.id,
    version: job.version,
    statusVersion: job.statusVersion,
    status: job.status,
    assigneeId: job.assigneeId,
  };
}

async function lockJob(tx: Tx, id: string): Promise<ServiceJob> {
  const [job] = await tx.select().from(schema.serviceJob).where(eq(schema.serviceJob.id, id)).limit(1).for("update");
  if (!job) throw new NotFoundError();
  return job;
}

async function charge(tx: Tx, actorId: string) {
  await consumeRate(tx, actorId, "api_write", DISPATCH_WRITE_LIMIT, DISPATCH_WRITE_MESSAGE);
}

async function recordEvent(
  tx: Tx,
  event: {
    jobId: string;
    actorId: string;
    kind: JobEventKind;
    fromStatus: ServiceJobStatus | null;
    toStatus: ServiceJobStatus | null;
  },
) {
  await tx.insert(schema.jobEvent).values(event);
}

function sameWindow(job: ServiceJob, start: Date | null, end: Date | null): boolean {
  return (job.scheduledStart?.getTime() ?? null) === (start?.getTime() ?? null) && (job.scheduledEnd?.getTime() ?? null) === (end?.getTime() ?? null);
}

async function writeJob(
  tx: Tx,
  job: ServiceJob,
  expectedVersion: number,
  patch: {
    assigneeId: string | null;
    status: ServiceJobStatus;
    scheduledStart: Date | null;
    scheduledEnd: Date | null;
    completedAt?: Date | null;
    bumpStatusVersion: boolean;
  },
): Promise<ServiceJob> {
  const [updated] = await tx
    .update(schema.serviceJob)
    .set({
      assigneeId: patch.assigneeId,
      status: patch.status,
      scheduledStart: patch.scheduledStart,
      scheduledEnd: patch.scheduledEnd,
      ...(patch.completedAt !== undefined ? { completedAt: patch.completedAt } : {}),
      version: sql`${schema.serviceJob.version} + 1`,
      ...(patch.bumpStatusVersion ? { statusVersion: sql`${schema.serviceJob.statusVersion} + 1` } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(schema.serviceJob.id, job.id), eq(schema.serviceJob.version, expectedVersion)))
    .returning();
  if (!updated) throw new ConflictError(STALE);
  return updated;
}

export async function assignJob(actor: Actor, input: unknown): Promise<JobChange> {
  assertDispatcher(actor);
  const data = assignJobInput.parse(input);
  return db().transaction(async (tx) => {
    const job = await lockJob(tx, data.jobId);
    if (!data.assigneeId) return unassign(tx, actor, job, data.version);
    if (job.status === "cancelled") throw new ConflictError("A cancelled job can't be assigned.");
    if (job.status === "completed") throw new ConflictError("Reopen the job before assigning it.");
    const [tech] = await tx
      .select({ id: schema.user.id, role: schema.user.role })
      .from(schema.user)
      .where(eq(schema.user.id, data.assigneeId))
      .limit(1);
    if (!tech || tech.role !== "technician") throw new BadRequestError("Choose a technician.");
    const provided = readWindow(data.scheduledStart, data.scheduledEnd);
    const start = provided?.start ?? job.scheduledStart;
    const end = provided?.end ?? job.scheduledEnd;
    if (!start || !end) throw new BadRequestError("Set a start and end to assign this job.");
    const nextStatus: ServiceJobStatus = job.status === "unassigned" ? "scheduled" : job.status;
    if (job.assigneeId === tech.id && job.status === nextStatus && sameWindow(job, start, end)) return changeOf(job);
    if (job.version !== data.version) throw new ConflictError(STALE);
    await charge(tx, actor.id);
    const assigneeChanged = job.assigneeId !== tech.id;
    const statusChanged = job.status !== nextStatus;
    const updated = await writeJob(tx, job, data.version, {
      assigneeId: tech.id,
      status: nextStatus,
      scheduledStart: start,
      scheduledEnd: end,
      bumpStatusVersion: assigneeChanged || statusChanged,
    });
    await recordEvent(tx, {
      jobId: job.id,
      actorId: actor.id,
      kind: assigneeChanged || statusChanged ? "assigned" : "rescheduled",
      fromStatus: job.status,
      toStatus: nextStatus,
    });
    return changeOf(updated);
  });
}

async function unassign(tx: Tx, actor: Actor, job: ServiceJob, expectedVersion: number): Promise<JobChange> {
  if (job.status === "cancelled") throw new ConflictError("A cancelled job can't be unassigned.");
  if (job.status === "completed") throw new ConflictError("Reopen the job before changing who it's assigned to.");
  if (!job.assigneeId && job.status === "unassigned" && !job.scheduledStart && !job.scheduledEnd) return changeOf(job);
  if (job.version !== expectedVersion) throw new ConflictError(STALE);
  await charge(tx, actor.id);
  const updated = await writeJob(tx, job, expectedVersion, {
    assigneeId: null,
    status: "unassigned",
    scheduledStart: null,
    scheduledEnd: null,
    bumpStatusVersion: true,
  });
  await recordEvent(tx, {
    jobId: job.id,
    actorId: actor.id,
    kind: "unassigned",
    fromStatus: job.status,
    toStatus: "unassigned",
  });
  return changeOf(updated);
}

export async function rescheduleJob(actor: Actor, input: unknown): Promise<JobChange> {
  assertDispatcher(actor);
  const data = rescheduleJobInput.parse(input);
  const window = readWindow(data.scheduledStart, data.scheduledEnd);
  if (!window) throw new BadRequestError("Enter a valid start and end.");
  return db().transaction(async (tx) => {
    const job = await lockJob(tx, data.jobId);
    if (job.status === "cancelled" || job.status === "completed") throw new ConflictError("This job can't be rescheduled.");
    if (!job.assigneeId) throw new BadRequestError("Assign a technician before setting a time.");
    if (sameWindow(job, window.start, window.end)) return changeOf(job);
    if (job.version !== data.version) throw new ConflictError(STALE);
    await charge(tx, actor.id);
    const updated = await writeJob(tx, job, data.version, {
      assigneeId: job.assigneeId,
      status: job.status,
      scheduledStart: window.start,
      scheduledEnd: window.end,
      bumpStatusVersion: false,
    });
    await recordEvent(tx, {
      jobId: job.id,
      actorId: actor.id,
      kind: "rescheduled",
      fromStatus: job.status,
      toStatus: job.status,
    });
    return changeOf(updated);
  });
}

export async function cancelJob(actor: Actor, input: unknown): Promise<JobChange> {
  assertDispatcher(actor);
  const data = jobVersionInput.parse(input);
  return db().transaction(async (tx) => {
    const job = await lockJob(tx, data.jobId);
    if (job.status === "cancelled") return changeOf(job);
    if (job.status === "completed") throw new ConflictError("A completed job stays completed. Reopen it first.");
    if (job.version !== data.version) throw new ConflictError(STALE);
    await charge(tx, actor.id);
    const updated = await writeJob(tx, job, data.version, {
      assigneeId: job.assigneeId,
      status: "cancelled",
      scheduledStart: job.scheduledStart,
      scheduledEnd: job.scheduledEnd,
      bumpStatusVersion: true,
    });
    await recordEvent(tx, {
      jobId: job.id,
      actorId: actor.id,
      kind: "status",
      fromStatus: job.status,
      toStatus: "cancelled",
    });
    return changeOf(updated);
  });
}

export async function reopenJob(actor: Actor, input: unknown): Promise<JobChange> {
  assertDispatcher(actor);
  const data = jobVersionInput.parse(input);
  return db().transaction(async (tx) => {
    const job = await lockJob(tx, data.jobId);
    if (job.status === "scheduled") return changeOf(job);
    if (job.status !== "completed" && job.status !== "on_hold") {
      throw new ConflictError("Reopen a completed or on-hold job.");
    }
    if (!job.assigneeId) throw new BadRequestError("Assign a technician before reopening.");
    if (job.version !== data.version) throw new ConflictError(STALE);
    await charge(tx, actor.id);
    const updated = await writeJob(tx, job, data.version, {
      assigneeId: job.assigneeId,
      status: "scheduled",
      scheduledStart: job.scheduledStart,
      scheduledEnd: job.scheduledEnd,
      completedAt: null,
      bumpStatusVersion: true,
    });
    await recordEvent(tx, {
      jobId: job.id,
      actorId: actor.id,
      kind: "status",
      fromStatus: job.status,
      toStatus: "scheduled",
    });
    return changeOf(updated);
  });
}

export type WorkOrderChange = { version: number; status: WorkOrderStatus };

export async function approveWorkOrder(actor: Actor, input: unknown): Promise<WorkOrderChange> {
  assertDispatcher(actor);
  const data = jobVersionInput.parse(input);
  return db().transaction(async (tx) => {
    await lockJob(tx, data.jobId);
    const order = await lockWorkOrder(tx, data.jobId);
    if (!order) throw new NotFoundError("No work order on this job.");
    if (order.status === "approved") return { version: order.version, status: "approved" };
    if (order.status !== "submitted") throw new ConflictError("Approve a submitted work order.");
    if (order.version !== data.version) throw new ConflictError(STALE_ORDER);
    await charge(tx, actor.id);
    const [updated] = await tx
      .update(schema.workOrder)
      .set({
        status: "approved",
        approvedBy: actor.id,
        version: sql`${schema.workOrder.version} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(schema.workOrder.id, order.id), eq(schema.workOrder.version, data.version)))
      .returning();
    if (!updated) throw new ConflictError(STALE_ORDER);
    return { version: updated.version, status: updated.status };
  });
}

export async function returnWorkOrder(actor: Actor, input: unknown): Promise<WorkOrderChange> {
  assertDispatcher(actor);
  const data = returnWorkOrderInput.parse(input);
  return db().transaction(async (tx) => {
    await lockJob(tx, data.jobId);
    const order = await lockWorkOrder(tx, data.jobId);
    if (!order) throw new NotFoundError("No work order on this job.");
    if (order.status === "approved") throw new ConflictError("An approved work order can't be changed.");
    if (order.status === "returned") {
      if (order.returnReason === data.reason) return { version: order.version, status: "returned" };
      throw new ConflictError(STALE_ORDER);
    }
    if (order.status !== "submitted") throw new ConflictError("Return a submitted work order.");
    if (order.version !== data.version) throw new ConflictError(STALE_ORDER);
    await charge(tx, actor.id);
    const [updated] = await tx
      .update(schema.workOrder)
      .set({
        status: "returned",
        returnReason: data.reason,
        version: sql`${schema.workOrder.version} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(schema.workOrder.id, order.id), eq(schema.workOrder.version, data.version)))
      .returning();
    if (!updated) throw new ConflictError(STALE_ORDER);
    return { version: updated.version, status: updated.status };
  });
}

async function lockWorkOrder(tx: Tx, jobId: string) {
  const [row] = await tx.select().from(schema.workOrder).where(eq(schema.workOrder.jobId, jobId)).limit(1).for("update");
  return row ?? null;
}

function readTasks(value: unknown): { tasks: WorkOrderTask[]; tasksUnreadable: boolean } {
  if (value == null) return { tasks: [], tasksUnreadable: false };
  const parsed = taskList.safeParse(value);
  return parsed.success ? { tasks: parsed.data, tasksUnreadable: false } : { tasks: [], tasksUnreadable: true };
}

function readAi(value: unknown): { ai: WorkOrderAi; aiUnreadable: boolean } {
  if (value == null) return { ai: {}, aiUnreadable: false };
  const parsed = aiRecord.safeParse(value);
  return parsed.success ? { ai: parsed.data, aiUnreadable: false } : { ai: {}, aiUnreadable: true };
}

export async function getJobDetail(actor: Actor, id: string): Promise<JobDetail> {
  assertDispatcher(actor);
  const jobId = z.uuid().parse(id);
  const [job] = await db()
    .select({
      id: schema.serviceJob.id,
      number: schema.serviceJob.number,
      title: schema.serviceJob.title,
      description: schema.serviceJob.description,
      priority: schema.serviceJob.priority,
      status: schema.serviceJob.status,
      scheduledStart: schema.serviceJob.scheduledStart,
      scheduledEnd: schema.serviceJob.scheduledEnd,
      version: schema.serviceJob.version,
      assigneeId: schema.serviceJob.assigneeId,
      assigneeName: schema.user.name,
      customerId: schema.customer.id,
      customerName: schema.customer.name,
      customerPhone: schema.customer.phone,
      siteId: schema.site.id,
      siteLabel: schema.site.label,
      siteAddress: schema.site.address,
      accessNotes: schema.site.accessNotes,
      siteLat: schema.site.lat,
      siteLng: schema.site.lng,
    })
    .from(schema.serviceJob)
    .innerJoin(schema.customer, eq(schema.serviceJob.customerId, schema.customer.id))
    .innerJoin(schema.site, eq(schema.serviceJob.siteId, schema.site.id))
    .leftJoin(schema.user, eq(schema.serviceJob.assigneeId, schema.user.id))
    .where(eq(schema.serviceJob.id, jobId))
    .limit(1);
  if (!job) throw new NotFoundError();

  const noteRows = await db()
    .select({
      id: schema.jobNote.id,
      body: schema.jobNote.body,
      authorName: schema.user.name,
      serverAt: schema.jobNote.serverAt,
    })
    .from(schema.jobNote)
    .innerJoin(schema.user, eq(schema.jobNote.authorId, schema.user.id))
    .where(eq(schema.jobNote.jobId, jobId))
    .orderBy(desc(schema.jobNote.serverAt))
    .limit(50);

  const eventRows = await db()
    .select({
      id: schema.jobEvent.id,
      kind: schema.jobEvent.kind,
      fromStatus: schema.jobEvent.fromStatus,
      toStatus: schema.jobEvent.toStatus,
      actorName: schema.user.name,
      serverAt: schema.jobEvent.serverAt,
      lat: schema.jobEvent.lat,
      lng: schema.jobEvent.lng,
      accuracyM: schema.jobEvent.accuracyM,
      late: schema.jobEvent.late,
    })
    .from(schema.jobEvent)
    .innerJoin(schema.user, eq(schema.jobEvent.actorId, schema.user.id))
    .where(eq(schema.jobEvent.jobId, jobId))
    .orderBy(desc(schema.jobEvent.serverAt))
    .limit(100);

  const [order] = await db().select().from(schema.workOrder).where(eq(schema.workOrder.jobId, jobId)).limit(1);
  let workOrder: WorkOrderView | null = null;
  if (order) {
    const lines = await db()
      .select({
        id: schema.workOrderLine.id,
        mentioned: schema.workOrderLine.mentioned,
        qty: schema.workOrderLine.qty,
        unit: schema.workOrderLine.unit,
        used: schema.workOrderLine.used,
        source: schema.workOrderLine.source,
        flags: schema.workOrderLine.flags,
        sku: schema.part.sku,
        partName: schema.part.name,
      })
      .from(schema.workOrderLine)
      .leftJoin(schema.part, eq(schema.workOrderLine.partId, schema.part.id))
      .where(eq(schema.workOrderLine.workOrderId, order.id))
      .orderBy(asc(schema.workOrderLine.position), asc(schema.workOrderLine.id));
    const names = [order.submittedBy, order.approvedBy].filter((value): value is string => Boolean(value));
    const people = names.length
      ? await db()
          .select({ id: schema.user.id, name: schema.user.name })
          .from(schema.user)
          .where(inArray(schema.user.id, names))
      : [];
    const nameOf = (userId: string | null) => people.find((person) => person.id === userId)?.name ?? null;
    const tasks = readTasks(order.tasks);
    const ai = readAi(order.ai);
    workOrder = {
      id: order.id,
      status: order.status,
      summary: order.summary,
      tasks: tasks.tasks,
      tasksUnreadable: tasks.tasksUnreadable,
      followUp: order.followUp,
      returnReason: order.returnReason,
      version: order.version,
      demo: ai.ai.demo === true,
      dropped: ai.ai.dropped ?? [],
      safety: ai.ai.safety ?? [],
      aiUnreadable: ai.aiUnreadable,
      submittedByName: nameOf(order.submittedBy),
      approvedByName: nameOf(order.approvedBy),
      lines: lines.map((line) => ({ ...line, flags: line.flags ?? [] })),
    };
  }

  return {
    id: job.id,
    number: job.number,
    title: job.title,
    description: job.description,
    priority: job.priority,
    status: job.status,
    scheduledStart: job.scheduledStart,
    scheduledEnd: job.scheduledEnd,
    version: job.version,
    assigneeId: job.assigneeId,
    assigneeName: job.assigneeName,
    customer: { id: job.customerId, name: job.customerName, phone: job.customerPhone },
    site: {
      id: job.siteId,
      label: job.siteLabel,
      address: job.siteAddress,
      accessNotes: job.accessNotes,
      lat: job.siteLat,
      lng: job.siteLng,
    },
    notes: noteRows,
    events: eventRows,
    workOrder,
  };
}
