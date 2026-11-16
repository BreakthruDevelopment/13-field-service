"use server";

import { ZodError } from "zod";
import { AiError } from "@/lib/ai/types";
import { ForbiddenError, UnauthorizedError } from "@/lib/auth/rbac";
import { requireRole } from "@/lib/auth/session";
import { HttpError, VersionConflictError } from "@/lib/errors";
import { listParts } from "@/lib/parts";
import { generateWorkOrder, getWorkOrder, updateWorkOrder, WorkOrderError, type WorkOrderDto } from "@/lib/work-orders";

export type { WorkOrderDto };

export type PartPick = { sku: string; name: string; unit: string };

export type WorkOrderActionResult = {
  ok: boolean;
  error?: string;
  code?: string;
  workOrder?: WorkOrderDto | null;
  replayed?: boolean;
};

export type WorkOrderEdit = {
  clientOpId: string;
  version: number;
  summary: string;
  tasks: { description: string; state: "done" | "to_do" }[];
  followUp: string | null;
  lines: { sku: string | null; mentioned: string; qty: number; unit: string; used: "used" | "needed" }[];
};

function isWorkOrder(value: unknown): value is WorkOrderDto {
  return !!value && typeof value === "object" && "jobId" in value && "version" in value && "lines" in value && "status" in value;
}

function fail(err: unknown): WorkOrderActionResult {
  if (err instanceof ZodError) return { ok: false, error: err.issues[0]?.message ?? "Check the form and try again." };
  if (err instanceof VersionConflictError) {
    return {
      ok: false,
      error: "Someone else changed this work order. Review the latest version and try again.",
      code: "stale_version",
      workOrder: isWorkOrder(err.current) ? err.current : null,
    };
  }
  if (err instanceof WorkOrderError) return { ok: false, error: err.message, code: err.code };
  if (err instanceof UnauthorizedError) return { ok: false, error: "Sign in to continue.", code: "signed_out" };
  if (err instanceof ForbiddenError) return { ok: false, error: "Only the assigned technician can change this work order." };
  if (err instanceof AiError) {
    return err.kind === "quota"
      ? { ok: false, error: "The work-order draft limit was reached. Try again later.", code: "rate_limit" }
      : { ok: false, error: "The draft couldn't be written. Nothing was saved. Try again.", code: "ai_failed" };
  }
  if (err instanceof HttpError && err.status < 500) {
    return {
      ok: false,
      error: err.status === 429 ? "Too many requests, try again in a minute." : err.message,
      code: err.status === 429 ? "rate_limit" : undefined,
    };
  }
  throw err;
}

/** The technician's work order, or null when the job has none yet. Online only; the job page does not call this for job data. */
export async function loadWorkOrderAction(jobId: string): Promise<WorkOrderActionResult> {
  try {
    const user = await requireRole("technician");
    return { ok: true, workOrder: await getWorkOrder(user, jobId) };
  } catch (err) {
    return fail(err);
  }
}

/** One click on "Draft with AI". The same clientOpId replays the first draft and is not charged again. */
export async function draftWorkOrderAction(jobId: string, clientOpId: string, baseVersion: number | null): Promise<WorkOrderActionResult> {
  try {
    const user = await requireRole("technician");
    const result = await generateWorkOrder(user, jobId, { clientOpId, baseVersion });
    return { ok: true, workOrder: result.workOrder, replayed: result.replayed };
  } catch (err) {
    return fail(err);
  }
}

export async function saveWorkOrderAction(jobId: string, input: WorkOrderEdit): Promise<WorkOrderActionResult> {
  try {
    const user = await requireRole("technician");
    const result = await updateWorkOrder(user, jobId, { op: "edit", ...input });
    return { ok: true, workOrder: result.workOrder, replayed: result.replayed };
  } catch (err) {
    return fail(err);
  }
}

export async function submitWorkOrderAction(jobId: string, clientOpId: string, version: number): Promise<WorkOrderActionResult> {
  try {
    const user = await requireRole("technician");
    const result = await updateWorkOrder(user, jobId, { op: "submit", clientOpId, version });
    return { ok: true, workOrder: result.workOrder, replayed: result.replayed };
  } catch (err) {
    return fail(err);
  }
}

/** Active catalog parts for the line picker. Technicians never see inactive parts. */
export async function searchPartsAction(q: string): Promise<{ ok: true; parts: PartPick[] } | { ok: false; error: string }> {
  const query = q.trim();
  if (query.length < 2) return { ok: true, parts: [] };
  try {
    const user = await requireRole("technician");
    const listed = await listParts(user, { q: query.slice(0, 100), limit: 8 });
    return { ok: true, parts: listed.parts.map((part) => ({ sku: part.sku, name: part.name, unit: part.unit })) };
  } catch (err) {
    const result = fail(err);
    return { ok: false, error: result.error ?? "Couldn't search parts." };
  }
}
