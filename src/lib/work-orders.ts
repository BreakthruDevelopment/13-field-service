import "server-only";
import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, getTableColumns, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { assertCan, jobScope } from "@/lib/access";
import { type Actor, ForbiddenError, toRole } from "@/lib/auth/rbac";
import { AI_DRAFTS_PER_HOUR, aiJobLock, capLimits } from "@/lib/caps";
import { type Db, db, schema } from "@/lib/db";
import { env } from "@/lib/env";
import { BadRequestError, ConflictError, HttpError, NotFoundError, TooManyRequestsError, VersionConflictError } from "@/lib/errors";
import { log } from "@/lib/log";
import { safeErrorFields } from "@/lib/safe-error";
import { MAX_NOTES_PER_JOB, lockJob } from "@/lib/service-jobs";
import { jsonHasNul, text } from "@/lib/text";
import { advisoryLock, consumeRate, releaseDaily, releaseRateEvent, reserveDaily, type Tx } from "@/lib/usage";
import { RANKED_CANDIDATES, WHOLE_CATALOG_MAX, assembleDraft, buildPrompt, runWorkOrderModel } from "@/lib/work-order-ai";
import { type CatalogPart, type LineFlag, type SafetyChip, checkLines, safetyChips } from "@/lib/work-order-checks";
import { spendRead, writeTx } from "@/lib/write-tx";

/**
 * Work orders (13.3): the AI draft, the technician's edit and submit, the dispatcher's approve and return.
 *
 * Rules that hold for every function here:
 * - Access is `assertCan()` plus the job's scope: a technician reaches only their own job's order (404 otherwise, the
 *   same answer as a missing job), a dispatcher any. The acting user's row is re-read `for share` first, so a role
 *   revoked a moment ago stops working at once even with a live session.
 * - Lock order is the one in `caps.ts`: user row, job row, then the work order, then cap locks (rate, per-job AI, daily).
 * - Every operation carries a client op id kept in `work_order_op` (primary key actor + op id). A retry with the same
 *   payload returns the first result and changes and charges nothing; the same id with another payload is a 409.
 * - A stale `version` is a 409 carrying the current order.
 * - No line reaches the database without `checkLines()`, and a model never decides a part id: the server reads parts
 *   from the database and only matches SKUs it offered.
 */

const { serviceJob, workOrder, workOrderLine, workOrderOp, part, jobNote, user } = schema;

type Q = Db | Tx;
type Status = (typeof schema.WORK_ORDER_STATUSES)[number];

/** How long a draft claim without a result is believed to be running. After that a retry with the same op id takes it over. */
export const CLAIM_LEASE_SECONDS = 60;

export type WorkOrderErrorCode = "no_notes" | "work_order_locked" | "job_cancelled" | "op_id_reused" | "in_progress" | "invalid_state" | "claim_lost";

/** A refusal with a stable `code` the UI can switch on (`errorInfo` sends it). */
export class WorkOrderError extends ConflictError {
  constructor(
    readonly code: WorkOrderErrorCode,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export type WorkOrderLineDto = {
  id: string;
  /** Null: not a catalog part (flagged `unknown_part`). */
  partId: string | null;
  sku: string | null;
  partName: string | null;
  mentioned: string;
  qty: number;
  unit: (typeof schema.PART_UNITS)[number];
  used: "used" | "needed";
  source: "ai" | "human";
  flags: LineFlag[];
  position: number;
};

/** What the draft recorded about itself. `dropped` are the rows the checks removed, shown to the technician. */
export type WorkOrderAiMeta = {
  provider: string;
  model: string;
  demo: boolean;
  latencyMs: number;
  dropped: { mentioned: string; reason: "not_in_notes" }[];
  needsHumanBecause: string | null;
  notesSent: number;
  notesTotal: number;
  candidates: number;
};

export type WorkOrderDto = {
  id: string;
  jobId: string;
  status: Status;
  version: number;
  summary: string;
  tasks: { description: string; state: "done" | "to_do" }[];
  followUp: string | null;
  returnReason: string | null;
  lines: WorkOrderLineDto[];
  /** Null for an order nobody drafted with AI. */
  ai: WorkOrderAiMeta | null;
  /** "Safety: check before closing" chips, from a keyword filter over the job description and notes as they are now. */
  safety: SafetyChip[];
  submittedBy: string | null;
  approvedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkOrderResult = { workOrder: WorkOrderDto; replayed: boolean };

async function loadWorkOrder(q: Q, jobId: string): Promise<WorkOrderDto | null> {
  const [wo] = await q.select().from(workOrder).where(eq(workOrder.jobId, jobId));
  if (!wo) return null;
  const lines = await q
    .select({ line: workOrderLine, sku: part.sku, partName: part.name })
    .from(workOrderLine)
    .leftJoin(part, eq(part.id, workOrderLine.partId))
    .where(eq(workOrderLine.workOrderId, wo.id))
    .orderBy(asc(workOrderLine.position), asc(workOrderLine.id));
  const [job] = await q.select({ description: serviceJob.description, title: serviceJob.title }).from(serviceJob).where(eq(serviceJob.id, jobId));
  const notes = await q.select({ body: jobNote.body }).from(jobNote).where(eq(jobNote.jobId, jobId)).orderBy(asc(jobNote.serverAt), asc(jobNote.id)).limit(MAX_NOTES_PER_JOB);
  return {
    id: wo.id,
    jobId: wo.jobId,
    status: wo.status,
    version: wo.version,
    summary: wo.summary,
    tasks: wo.tasks,
    followUp: wo.followUp,
    returnReason: wo.returnReason,
    lines: lines.map(({ line: l, sku, partName }) => ({
      id: l.id,
      partId: l.partId,
      sku,
      partName,
      mentioned: l.mentioned,
      qty: Number(l.qty),
      unit: l.unit,
      used: l.used,
      source: l.source,
      flags: l.flags as LineFlag[],
      position: l.position,
    })),
    ai: (wo.ai as WorkOrderAiMeta | null) ?? null,
    safety: safetyChips(`${job?.title ?? ""}\n${job?.description ?? ""}\n${notes.map((n) => n.body).join("\n")}`),
    submittedBy: wo.submittedBy,
    approvedBy: wo.approvedBy,
    createdAt: wo.createdAt.toISOString(),
    updatedAt: wo.updatedAt.toISOString(),
  };
}

const lockWorkOrder = async (tx: Tx, jobId: string) => (await tx.select().from(workOrder).where(eq(workOrder.jobId, jobId)).for("update"))[0];

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const uuid = z.string().uuid();
const version = z.number().int().min(1);
const sku = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9-]{2,40}$/, "SKU is 2 to 40 letters, digits or dashes");

export const draftInput = z.strictObject({
  /** One id per click on "Draft with AI" (`opFor`): a retry returns the first draft and charges nothing. */
  clientOpId: uuid,
  /** The `version` of the work order the client is looking at, or null when there is none yet. A mismatch is a 409. */
  baseVersion: version.nullable(),
});

const lineInput = z.strictObject({
  sku: sku.nullable(),
  mentioned: text(120, { min: 1, minMessage: "Say what the part is" }),
  qty: z.number().positive().max(9999),
  unit: z.enum(schema.PART_UNITS),
  used: z.enum(schema.WORK_ORDER_LINE_USED),
});
const taskInput = z.strictObject({ description: text(200, { min: 1 }), state: z.enum(["done", "to_do"]) });

/** PATCH /api/jobs/:id/work-order. One op per request, always with the `version` last seen and a fresh `clientOpId`. */
export const workOrderPatchInput = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("edit"),
    clientOpId: uuid,
    version,
    summary: text(400).optional(),
    tasks: z.array(taskInput).max(12).optional(),
    followUp: text(300).nullable().optional(),
    /** Replaces all lines. Each is checked like an AI line (SKU verified, flags set); a line you didn't change keeps `source: ai`. */
    lines: z.array(lineInput).max(30).optional(),
  }),
  z.strictObject({ op: z.literal("submit"), clientOpId: uuid, version }),
  z.strictObject({ op: z.literal("approve"), clientOpId: uuid, version }),
  z.strictObject({ op: z.literal("return"), clientOpId: uuid, version, reason: text(300, { min: 1, minMessage: "Say what to fix" }) }),
]);

const hashOf = (kind: string, jobId: string, payload: unknown) => createHash("sha256").update(JSON.stringify([kind, jobId, payload])).digest("hex");

function refuseNul(input: unknown) {
  if (jsonHasNul(input)) throw new BadRequestError("Text can't contain null characters");
}

// ---------------------------------------------------------------------------
// Shared steps
// ---------------------------------------------------------------------------

/**
 * Re-read the acting user `for share` (the same first lock `updateJob` takes) and refuse when their role changed or they
 * were banned since the session was issued. Waits for a concurrent role change, so the check can't race it.
 */
async function assertActorCurrent(tx: Tx, actor: Actor): Promise<void> {
  const [row] = await tx.select({ role: user.role, banned: user.banned }).from(user).where(eq(user.id, actor.id)).for("share");
  if (!row || row.banned || toRole(row.role) !== actor.role) throw new ForbiddenError();
}

type OpRow = typeof workOrderOp.$inferSelect & { stale: boolean };

const findOp = async (tx: Tx, actorId: string, opId: string): Promise<OpRow | undefined> =>
  (
    await tx
      .select({ ...getTableColumns(workOrderOp), stale: sql<boolean>`${workOrderOp.claimedAt} < now() - make_interval(secs => ${CLAIM_LEASE_SECONDS})` })
      .from(workOrderOp)
      .where(and(eq(workOrderOp.actorId, actorId), eq(workOrderOp.opId, opId)))
      .for("update")
  )[0];

/** The op id was used before: for the same request it is a replay, for anything else a refusal that reveals nothing about the first. */
function assertSameRequest(op: OpRow, kind: (typeof schema.WORK_ORDER_OP_KINDS)[number], jobId: string, hash: string) {
  if (op.kind !== kind || op.jobId !== jobId || op.payloadHash !== hash) {
    throw new WorkOrderError("op_id_reused", "That request id was already used for a different request. Start the action again.");
  }
}

const storedWorkOrder = (op: OpRow): WorkOrderDto => (op.result as unknown as { workOrder: WorkOrderDto }).workOrder;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** GET /api/jobs/:id/work-order. The order, or null when the job has none yet. A technician's own job only (404 otherwise). */
export async function getWorkOrder(actor: Actor, id: string): Promise<WorkOrderDto | null> {
  assertCan(actor, "read", "work_order");
  const jobId = uuid.parse(id);
  await spendRead(actor);
  const [job] = await db().select({ assigneeId: serviceJob.assigneeId }).from(serviceJob).where(and(eq(serviceJob.id, jobId), jobScope(actor)));
  if (!job) throw new NotFoundError("Job not found");
  assertCan(actor, "read", "work_order", { assigneeId: job.assigneeId });
  return loadWorkOrder(db(), jobId);
}

// ---------------------------------------------------------------------------
// The AI draft
// ---------------------------------------------------------------------------

/** Words of the job text for the candidate ranking: lower case, 3 or more characters, only characters that are safe in a tsquery lexeme. */
export function rankWords(source: string): string[] {
  const words = source
    .toLowerCase()
    .split(/[^a-z0-9/.\-]+/)
    .map((w) => w.replace(/^[/.\-]+|[/.\-]+$/g, ""))
    .filter((w) => w.length >= 3 && /[a-z0-9]/.test(w));
  return [...new Set(words)].slice(0, 40);
}

/** The whole active catalog when it has at most 150 parts, else the top 60 by `ts_rank` against the job text; best match first. */
async function loadCandidates(tx: Tx, source: string): Promise<CatalogPart[]> {
  const [{ n }] = await tx.select({ n: count() }).from(part).where(eq(part.active, true));
  const words = rankWords(source);
  const rank = words.length
    ? sql<number>`coalesce(ts_rank(${part.search}, to_tsquery('simple', ${words.map((w) => `'${w}':*`).join(" | ")})), 0)`
    : sql<number>`0`;
  return tx
    .select({ id: part.id, sku: part.sku, name: part.name, unit: part.unit, maxPerJob: part.maxPerJob })
    .from(part)
    .where(eq(part.active, true))
    .orderBy(desc(rank), asc(part.sku))
    .limit(n <= WHOLE_CATALOG_MAX ? WHOLE_CATALOG_MAX : RANKED_CANDIDATES);
}

type Claim =
  | { type: "replay"; workOrder: WorkOrderDto }
  | { type: "run"; built: ReturnType<typeof buildPrompt> }
  /** A taken-over claim that can no longer be completed (the order moved on): refunded in the same transaction, then this is thrown. */
  | { type: "refused"; error: unknown };

/**
 * POST /api/jobs/:id/work-order/draft. Online only; the model runs inside this request (nothing runs in the background)
 * and never holds a database connection while it does:
 *
 *  1. One short transaction: access, replay lookup, every validation, then the three charges (user per hour, job per
 *     day, app per day) and the claim row. Anything refused here rolls the charges back with it.
 *  2. The model call, bounded by `AI_TIMEOUT_MS` (20 s).
 *  3. One short transaction writes the order and the lines (after the checks) and stores the result on the claim.
 *     If step 2 or 3 fails the charges are refunded and the claim removed, so a retry pays once.
 */
export async function generateWorkOrder(actor: Actor, id: string, input: unknown): Promise<WorkOrderResult> {
  assertCan(actor, "create", "work_order");
  const jobId = uuid.parse(id);
  refuseNul(input);
  const data = draftInput.parse(input);
  const hash = hashOf("generate", jobId, { baseVersion: data.baseVersion });

  const claim = await db().transaction(async (tx): Promise<Claim> => {
    await assertActorCurrent(tx, actor);
    const job = await lockJob(tx, actor, jobId);
    assertCan(actor, "create", "work_order", { assigneeId: job.assigneeId });

    let charge = true;
    const prior = await findOp(tx, actor.id, data.clientOpId);
    if (prior) {
      assertSameRequest(prior, "generate", jobId, hash);
      if (prior.result) return { type: "replay", workOrder: storedWorkOrder(prior) };
      // A claim without a result: still running, or its request died. Its charge is already held, so a takeover pays nothing more.
      if (!prior.stale) throw new WorkOrderError("in_progress", "That draft is still being written. Try again in a moment.");
      await tx.update(workOrderOp).set({ claimedAt: new Date() }).where(and(eq(workOrderOp.actorId, actor.id), eq(workOrderOp.opId, data.clientOpId)));
      charge = false;
    }

    const prepare = async () => {
      if (job.status === "cancelled") throw new WorkOrderError("job_cancelled", "This job was cancelled.");
      const wo = await lockWorkOrder(tx, jobId);
      if (wo && (wo.status === "submitted" || wo.status === "approved")) {
        throw new WorkOrderError("work_order_locked", "This work order is already submitted. A dispatcher has to return it before it can be redrafted.");
      }
      if ((wo?.version ?? null) !== data.baseVersion) throw new VersionConflictError(await loadWorkOrder(tx, jobId));
      const notes = await tx
        .select({ body: jobNote.body })
        .from(jobNote)
        .where(eq(jobNote.jobId, jobId))
        .orderBy(asc(jobNote.serverAt), asc(jobNote.id))
        .limit(MAX_NOTES_PER_JOB);
      if (notes.length === 0) throw new WorkOrderError("no_notes", "Add a note about the work before drafting a work order.");

      const bodies = notes.map((n) => n.body);
      const candidates = await loadCandidates(tx, [job.title, job.description, ...bodies].join(" "));
      const built = buildPrompt({ title: job.title, description: job.description, notes: bodies, candidates });

      return built;
    };
    let built: ReturnType<typeof buildPrompt>;
    try {
      built = await prepare();
    } catch (err) {
      // A claim being retaken that can't be completed any more (cancelled, submitted, a newer version, notes gone) would
      // otherwise keep its charges for good: every retry fails the same check. Refund it here, in this transaction.
      if (charge || !(err instanceof HttpError)) throw err;
      await refundClaim(tx, actor.id, data.clientOpId);
      return { type: "refused", error: err };
    }

    if (charge) {
      const rateEventId = await consumeRate(tx, actor.id, "ai", AI_DRAFTS_PER_HOUR, "You've asked for a lot of AI drafts this hour. Try again later.");
      await advisoryLock(tx, aiJobLock(jobId));
      const [{ n }] = await tx
        .select({ n: count() })
        .from(workOrderOp)
        .where(and(eq(workOrderOp.jobId, jobId), eq(workOrderOp.kind, "generate"), gt(workOrderOp.createdAt, sql`now() - interval '1 day'`)));
      if (n >= capLimits.aiPerJobDay) throw new TooManyRequestsError("This job has used its AI drafts for today. Try again tomorrow.");
      if (!(await reserveDaily(tx, "ai", env().AI_DAILY_CAP))) throw new TooManyRequestsError("The app's AI drafts for today are used up. Try again tomorrow.");
      const [mine] = await tx
        .insert(workOrderOp)
        .values({ actorId: actor.id, opId: data.clientOpId, kind: "generate", jobId, payloadHash: hash, rateEventId })
        .onConflictDoNothing()
        .returning({ opId: workOrderOp.opId });
      // Only a parallel request with the same id for a different job can get here (the same job is serialized by its row lock).
      if (!mine) throw new WorkOrderError("op_id_reused", "That request id was already used for a different request. Start the action again.");
    }
    return { type: "run", built };
  });

  if (claim.type === "replay") return { workOrder: claim.workOrder, replayed: true };
  if (claim.type === "refused") throw claim.error;

  let keepCharge = false;
  try {
    const run = await runWorkOrderModel(claim.built);
    const result = await db().transaction(async (tx): Promise<WorkOrderResult> => {
      await assertActorCurrent(tx, actor);
      const job = await lockJob(tx, actor, jobId); // 404 when the job was reassigned while the model ran
      assertCan(actor, "create", "work_order", { assigneeId: job.assigneeId });
      // Cancelling keeps the assignee and doesn't touch the work order's version, so neither check above sees it.
      if (job.status === "cancelled") throw new WorkOrderError("job_cancelled", "This job was cancelled while the draft was being written.");
      const op = await findOp(tx, actor.id, data.clientOpId);
      if (!op) {
        keepCharge = true; // a takeover removed the claim and refunded it
        throw new WorkOrderError("claim_lost", "That draft was cancelled. Try again.");
      }
      if (op.result) {
        keepCharge = true; // another attempt finished this very request: its result stands and it holds the one charge
        return { workOrder: storedWorkOrder(op), replayed: true };
      }
      const wo = await lockWorkOrder(tx, jobId);
      if (wo && (wo.status === "submitted" || wo.status === "approved")) {
        throw new WorkOrderError("work_order_locked", "This work order was submitted while the draft was being written.");
      }
      if ((wo?.version ?? null) !== data.baseVersion) throw new VersionConflictError(await loadWorkOrder(tx, jobId));

      // Verify every SKU against the database now, not against what was read before the model ran.
      const skus = [...new Set(run.output.parts.flatMap((p) => (p.sku ? [p.sku.toUpperCase()] : [])))];
      const verified: CatalogPart[] = skus.length
        ? await tx
            .select({ id: part.id, sku: part.sku, name: part.name, unit: part.unit, maxPerJob: part.maxPerJob })
            .from(part)
            .where(and(inArray(part.sku, skus), eq(part.active, true)))
        : [];
      const draft = assembleDraft(run.output, claim.built, verified);
      const ai: WorkOrderAiMeta = {
        provider: run.provider,
        model: run.model,
        demo: run.demo,
        latencyMs: run.latencyMs,
        dropped: draft.dropped,
        needsHumanBecause: draft.needsHumanBecause,
        notesSent: claim.built.notesSent,
        notesTotal: claim.built.notesTotal,
        candidates: claim.built.candidates.length,
      };
      const now = new Date();
      let orderId: string;
      if (wo) {
        // Regenerating replaces a draft or a returned order, and starts the review over.
        await tx
          .update(workOrder)
          .set({ status: "draft", summary: draft.summary, tasks: draft.tasks, followUp: draft.followUp, ai, returnReason: null, submittedBy: null, approvedBy: null, version: wo.version + 1, updatedAt: now })
          .where(eq(workOrder.id, wo.id));
        await tx.delete(workOrderLine).where(eq(workOrderLine.workOrderId, wo.id));
        orderId = wo.id;
      } else {
        const [row] = await tx
          .insert(workOrder)
          .values({ jobId, status: "draft", summary: draft.summary, tasks: draft.tasks, followUp: draft.followUp, ai })
          .returning({ id: workOrder.id });
        orderId = row.id;
      }
      if (draft.lines.length) {
        await tx.insert(workOrderLine).values(
          draft.lines.map((l, position) => ({
            workOrderId: orderId,
            partId: l.partId,
            mentioned: l.mentioned,
            qty: String(l.qty),
            unit: l.unit,
            used: l.used,
            source: "ai" as const,
            flags: l.flags,
            position,
          })),
        );
      }
      const dto = (await loadWorkOrder(tx, jobId)) as WorkOrderDto;
      await tx
        .update(workOrderOp)
        .set({ result: { workOrder: dto } })
        .where(and(eq(workOrderOp.actorId, actor.id), eq(workOrderOp.opId, data.clientOpId)));
      // Counts and codes only: never notes, the prompt or the answer's text.
      const flagCounts: Record<string, number> = {};
      for (const l of draft.lines) for (const f of l.flags) flagCounts[f] = (flagCounts[f] ?? 0) + 1;
      log.info("workorder.drafted", {
        actorId: actor.id,
        jobId,
        provider: run.provider,
        demo: run.demo,
        latencyMs: run.latencyMs,
        lines: draft.lines.length,
        dropped: draft.dropped.length,
        flags: flagCounts,
        safety: dto.safety.map((s) => s.code),
      });
      return { workOrder: dto, replayed: false };
    });
    return result;
  } catch (err) {
    if (!keepCharge) await refundDraft(actor, data.clientOpId);
    throw err;
  }
}

/**
 * Give back what step 1 charged and drop the claim, but only if the claim is still unfinished (so a draft that did
 * complete is never refunded). Best effort: if it fails, the claim stays and a retry after the lease takes it over
 * without paying twice.
 */
async function refundDraft(actor: Actor, opId: string): Promise<void> {
  try {
    await db().transaction((tx) => refundClaim(tx, actor.id, opId));
  } catch (err) {
    log.error("workorder.refund_failed", safeErrorFields(err));
  }
}

/** Delete the unfinished claim and return what it was charged: its rate event and its UTC day. Takes the rate lock, then the daily row. */
async function refundClaim(tx: Tx, actorId: string, opId: string): Promise<void> {
  const removed = await tx
    .delete(workOrderOp)
    .where(and(eq(workOrderOp.actorId, actorId), eq(workOrderOp.opId, opId), eq(workOrderOp.kind, "generate"), isNull(workOrderOp.result)))
    .returning({
      // The charge was taken in the transaction that created the claim, so its creation time is the UTC day that was
      // reserved (a takeover can refund long after), and `rateEventId` is the very rate event that paid for it.
      day: sql<string>`(${workOrderOp.createdAt} at time zone 'utc')::date::text`,
      rateEventId: workOrderOp.rateEventId,
    });
  if (removed.length === 0) return;
  if (removed[0].rateEventId) await releaseRateEvent(tx, actorId, "ai", removed[0].rateEventId);
  await releaseDaily(tx, "ai", removed[0].day);
}

// ---------------------------------------------------------------------------
// Edit, submit, approve, return
// ---------------------------------------------------------------------------

const sameLine = (a: { partId: string | null; mentioned: string; qty: number; unit: string; used: string }, b: typeof a) =>
  a.partId === b.partId && a.mentioned === b.mentioned && a.qty === b.qty && a.unit === b.unit && a.used === b.used;

/**
 * PATCH /api/jobs/:id/work-order. `edit` and `submit`: the job's technician (a dispatcher may also edit). `approve` and
 * `return`: dispatchers, on a submitted order. An approved order is read-only. Replays return the first result.
 */
export async function updateWorkOrder(actor: Actor, id: string, input: unknown): Promise<WorkOrderResult> {
  const jobId = uuid.parse(id);
  refuseNul(input);
  const data = workOrderPatchInput.parse(input);
  const action = data.op === "edit" ? "update" : data.op === "submit" ? "submit" : "approve";
  assertCan(actor, action, "work_order");
  const { clientOpId, ...payload } = data;
  const hash = hashOf(data.op, jobId, payload);

  const out = await writeTx(actor, async (tx): Promise<WorkOrderResult> => {
    await assertActorCurrent(tx, actor);
    const job = await lockJob(tx, actor, jobId);
    assertCan(actor, action, "work_order", { assigneeId: job.assigneeId });
    // A cancelled job's order is frozen: nothing may be edited, submitted, approved or returned on it.
    if (job.status === "cancelled") throw new WorkOrderError("job_cancelled", "This job was cancelled, so its work order can't be changed.");

    const prior = await findOp(tx, actor.id, clientOpId);
    if (prior) {
      assertSameRequest(prior, data.op, jobId, hash);
      if (!prior.result) throw new WorkOrderError("in_progress", "That change is still being applied. Try again in a moment.");
      return { workOrder: storedWorkOrder(prior), replayed: true };
    }

    const wo = await lockWorkOrder(tx, jobId);
    if (!wo) throw new NotFoundError("Work order not found");
    if (wo.version !== data.version) throw new VersionConflictError(await loadWorkOrder(tx, jobId));
    const now = new Date();
    const bump = { version: wo.version + 1, updatedAt: now };
    const locked = (message: string) => new WorkOrderError("work_order_locked", message);

    switch (data.op) {
      case "edit": {
        if (wo.status === "approved") throw locked("This work order is approved and can't be changed.");
        if (actor.role === "technician" && wo.status === "submitted") throw locked("This work order is submitted. Ask the dispatcher to return it before you change it.");
        const set: Partial<typeof workOrder.$inferInsert> = { ...bump };
        if (data.summary !== undefined) set.summary = data.summary;
        if (data.tasks !== undefined) set.tasks = data.tasks;
        if (data.followUp !== undefined) set.followUp = data.followUp;
        await tx.update(workOrder).set(set).where(eq(workOrder.id, wo.id));
        if (data.lines !== undefined) {
          const existing = await tx.select().from(workOrderLine).where(eq(workOrderLine.workOrderId, wo.id));
          const skus = [...new Set(data.lines.flatMap((l) => (l.sku ? [l.sku] : [])))];
          const keepIds = existing.flatMap((l) => (l.partId ? [l.partId] : []));
          // A part deactivated since the draft stays usable on this order; any other SKU must be an active catalog part.
          const verified: CatalogPart[] = skus.length
            ? await tx
                .select({ id: part.id, sku: part.sku, name: part.name, unit: part.unit, maxPerJob: part.maxPerJob })
                .from(part)
                .where(and(inArray(part.sku, skus), or(eq(part.active, true), keepIds.length ? inArray(part.id, keepIds) : undefined)))
            : [];
          const { lines } = checkLines(data.lines, { catalog: new Map(verified.map((p) => [p.sku, p] as const)), sourceText: null });
          const aiLines = existing.filter((l) => l.source === "ai").map((l) => ({ partId: l.partId, mentioned: l.mentioned, qty: Number(l.qty), unit: l.unit as string, used: l.used as string }));
          await tx.delete(workOrderLine).where(eq(workOrderLine.workOrderId, wo.id));
          if (lines.length) {
            await tx.insert(workOrderLine).values(
              lines.map((l, position) => ({
                workOrderId: wo.id,
                partId: l.partId,
                mentioned: l.mentioned,
                qty: String(l.qty),
                unit: l.unit,
                used: l.used,
                // An untouched AI line stays "ai"; anything a person added or changed is "human".
                source: aiLines.some((a) => sameLine(a, { partId: l.partId, mentioned: l.mentioned, qty: l.qty, unit: l.unit, used: l.used })) ? ("ai" as const) : ("human" as const),
                flags: l.flags,
                position,
              })),
            );
          }
        }
        break;
      }
      case "submit": {
        if (wo.status !== "draft" && wo.status !== "returned") throw new WorkOrderError("invalid_state", "Only a draft or a returned work order can be submitted.");
        if (wo.summary.trim() === "") throw new BadRequestError("Add a summary before submitting.");
        await tx.update(workOrder).set({ ...bump, status: "submitted", submittedBy: actor.id, returnReason: null }).where(eq(workOrder.id, wo.id));
        break;
      }
      case "approve": {
        if (wo.status !== "submitted") throw new WorkOrderError("invalid_state", "Only a submitted work order can be approved.");
        await tx.update(workOrder).set({ ...bump, status: "approved", approvedBy: actor.id }).where(eq(workOrder.id, wo.id));
        break;
      }
      case "return": {
        if (wo.status !== "submitted") throw new WorkOrderError("invalid_state", "Only a submitted work order can be returned.");
        await tx.update(workOrder).set({ ...bump, status: "returned", returnReason: data.reason, approvedBy: null }).where(eq(workOrder.id, wo.id));
        break;
      }
    }

    const dto = (await loadWorkOrder(tx, jobId)) as WorkOrderDto;
    const [mine] = await tx
      .insert(workOrderOp)
      .values({ actorId: actor.id, opId: clientOpId, kind: data.op, jobId, payloadHash: hash, result: { workOrder: dto } })
      .onConflictDoNothing()
      .returning({ opId: workOrderOp.opId });
    if (!mine) throw new WorkOrderError("op_id_reused", "That request id was already used for a different request. Start the action again.");
    return { workOrder: dto, replayed: false };
  });
  if (!out.replayed) log.info(`workorder.${data.op}`, { actorId: actor.id, jobId, status: out.workOrder.status });
  return out;
}
