import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { type Actor, ForbiddenError } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/errors";
import { text } from "@/lib/text";
import { PART_UNITS, type WorkOrderLineView, type WorkOrderView } from "@/lib/tech-view";

const taskSchema = z.object({
  description: text(200, { min: 1 }),
  state: z.enum(["done", "to_do"]),
});

const lineSchema = z.object({
  mentioned: text(120, { min: 1 }),
  qty: z.number().positive().max(9999),
  unit: z.enum(PART_UNITS),
  used: z.enum(["used", "needed"]),
});

const saveSchema = z.object({
  version: z.number().int().positive(),
  summary: text(400),
  tasks: z.array(taskSchema).max(12),
  followUp: text(300),
  lines: z.array(lineSchema).max(30),
  submit: z.boolean().optional(),
});

function requireTechnician(actor: Actor): void {
  if (actor.role !== "technician") throw new ForbiddenError();
}

async function ownJob(actor: Actor, jobId: string) {
  const parsed = z.string().uuid().parse(jobId);
  const [job] = await db().select().from(schema.serviceJob).where(eq(schema.serviceJob.id, parsed));
  // Missing and someone else's job are the same answer, so an id can't be probed.
  if (!job || job.assigneeId !== actor.id) throw new NotFoundError();
  return job;
}

function num(value: string | number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function readView(jobId: string): Promise<WorkOrderView | null> {
  const [order] = await db().select().from(schema.workOrder).where(eq(schema.workOrder.jobId, jobId));
  if (!order) return null;
  const lines = await db()
    .select()
    .from(schema.workOrderLine)
    .where(eq(schema.workOrderLine.workOrderId, order.id))
    .orderBy(asc(schema.workOrderLine.position));
  return {
    jobId,
    status: order.status,
    summary: order.summary,
    tasks: order.tasks ?? [],
    followUp: order.followUp,
    lines: lines.map(
      (line): WorkOrderLineView => ({
        mentioned: line.mentioned,
        qty: num(line.qty),
        unit: line.unit,
        used: line.used,
      }),
    ),
    version: order.version,
    returnReason: order.returnReason,
  };
}

export async function getWorkOrder(actor: Actor, jobId: string): Promise<WorkOrderView | null> {
  requireTechnician(actor);
  const job = await ownJob(actor, jobId);
  return readView(job.id);
}

export async function saveWorkOrder(actor: Actor, jobId: string, input: unknown): Promise<WorkOrderView> {
  requireTechnician(actor);
  const job = await ownJob(actor, jobId);
  const data = saveSchema.parse(input);
  if (data.submit && data.summary.length < 1) throw new BadRequestError("Add a summary before submitting.");

  await db().transaction(async (tx) => {
    const [existing] = await tx.select().from(schema.workOrder).where(eq(schema.workOrder.jobId, job.id)).for("update");
    if (existing && (existing.status === "submitted" || existing.status === "approved")) {
      throw new ConflictError("This work order is with the office and can't be edited.");
    }
    if (existing && existing.version !== data.version) {
      throw new ConflictError("This work order changed. Load it again.");
    }
    const nextStatus = data.submit ? "submitted" : existing?.status === "returned" ? "returned" : "draft";
    const nextVersion = (existing?.version ?? 0) + 1;
    const now = new Date();
    let workOrderId = existing?.id;
    if (!existing) {
      const inserted = await tx
        .insert(schema.workOrder)
        .values({
          jobId: job.id,
          status: nextStatus,
          summary: data.summary,
          tasks: data.tasks,
          followUp: data.followUp,
          version: nextVersion,
          submittedBy: data.submit ? actor.id : null,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: schema.workOrder.id });
      if (!inserted[0]) throw new ConflictError("This work order changed. Load it again.");
      workOrderId = inserted[0].id;
    } else {
      const updated = await tx
        .update(schema.workOrder)
        .set({
          status: nextStatus,
          summary: data.summary,
          tasks: data.tasks,
          followUp: data.followUp,
          version: nextVersion,
          submittedBy: data.submit ? actor.id : existing.submittedBy,
          updatedAt: now,
        })
        .where(and(eq(schema.workOrder.id, existing.id), eq(schema.workOrder.version, existing.version)))
        .returning({ id: schema.workOrder.id });
      if (!updated[0]) throw new ConflictError("This work order changed. Load it again.");
    }
    await tx.delete(schema.workOrderLine).where(eq(schema.workOrderLine.workOrderId, workOrderId!));
    if (data.lines.length > 0) {
      await tx.insert(schema.workOrderLine).values(
        data.lines.map((line, position) => ({
          workOrderId: workOrderId!,
          mentioned: line.mentioned,
          qty: line.qty.toFixed(2),
          unit: line.unit,
          used: line.used,
          source: "human" as const,
          position,
        })),
      );
    }
  });

  const view = await readView(job.id);
  if (!view) throw new ConflictError("This work order changed. Load it again.");
  return view;
}
