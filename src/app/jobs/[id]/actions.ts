"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/session";
import { type ActionState, actionFailure } from "@/lib/action-error";
import { approveWorkOrder, assignJob, cancelJob, reopenJob, rescheduleJob, returnWorkOrder } from "@/lib/job-detail";

function read(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}

function refreshJob(jobId: string) {
  revalidatePath("/customers");
  revalidatePath("/customers/[id]", "page");
  revalidatePath("/jobs/[id]", "page");
  revalidatePath(`/jobs/${jobId}`);
}

export async function assignJobAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const user = await requireRole("dispatcher");
    const jobId = read(form, "jobId");
    await assignJob(user, {
      jobId,
      version: read(form, "version"),
      assigneeId: read(form, "assigneeId"),
      scheduledStart: read(form, "scheduledStart"),
      scheduledEnd: read(form, "scheduledEnd"),
    });
    refreshJob(jobId);
    return { ok: true };
  } catch (err) {
    const failure = actionFailure(err);
    if (failure) return failure;
    throw err;
  }
}

export async function rescheduleJobAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const user = await requireRole("dispatcher");
    const jobId = read(form, "jobId");
    await rescheduleJob(user, {
      jobId,
      version: read(form, "version"),
      scheduledStart: read(form, "scheduledStart"),
      scheduledEnd: read(form, "scheduledEnd"),
    });
    refreshJob(jobId);
    return { ok: true };
  } catch (err) {
    const failure = actionFailure(err);
    if (failure) return failure;
    throw err;
  }
}

export async function cancelJobAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const user = await requireRole("dispatcher");
    const jobId = read(form, "jobId");
    await cancelJob(user, { jobId, version: read(form, "version") });
    refreshJob(jobId);
    return { ok: true };
  } catch (err) {
    const failure = actionFailure(err);
    if (failure) return failure;
    throw err;
  }
}

export async function reopenJobAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const user = await requireRole("dispatcher");
    const jobId = read(form, "jobId");
    await reopenJob(user, { jobId, version: read(form, "version") });
    refreshJob(jobId);
    return { ok: true };
  } catch (err) {
    const failure = actionFailure(err);
    if (failure) return failure;
    throw err;
  }
}

export async function approveWorkOrderAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const user = await requireRole("dispatcher");
    const jobId = read(form, "jobId");
    await approveWorkOrder(user, { jobId, version: read(form, "version") });
    refreshJob(jobId);
    return { ok: true };
  } catch (err) {
    const failure = actionFailure(err);
    if (failure) return failure;
    throw err;
  }
}

export async function returnWorkOrderAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const user = await requireRole("dispatcher");
    const jobId = read(form, "jobId");
    await returnWorkOrder(user, { jobId, version: read(form, "version"), reason: read(form, "reason") });
    refreshJob(jobId);
    return { ok: true };
  } catch (err) {
    const failure = actionFailure(err);
    if (failure) return failure;
    throw err;
  }
}
