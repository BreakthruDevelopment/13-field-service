"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { ForbiddenError, UnauthorizedError } from "@/lib/auth/rbac";
import { requireRole } from "@/lib/auth/session";
import { HttpError, VersionConflictError } from "@/lib/errors";
import { isTimeZone, zonedLocalToIso } from "@/lib/job-display";
import { updateJob } from "@/lib/service-jobs";

export type AssignState = { error?: string; ok?: boolean };

function read(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}

function fail(err: unknown): AssignState {
  if (err instanceof VersionConflictError) {
    return { error: "Someone else changed this job. The board was refreshed; try again." };
  }
  if (err instanceof ZodError) return { error: err.issues[0]?.message ?? "Check the form and try again." };
  if (err instanceof UnauthorizedError) return { error: "Sign in to continue." };
  if (err instanceof ForbiddenError) return { error: "Only a dispatcher can assign a job." };
  if (err instanceof HttpError && err.status < 500) {
    return { error: err.status === 429 ? "Too many requests, try again in a minute." : err.message };
  }
  throw err;
}

export async function assignJobAction(_prev: AssignState, form: FormData): Promise<AssignState> {
  try {
    const user = await requireRole("dispatcher");
    const tzRaw = read(form, "tz");
    const tz = isTimeZone(tzRaw) ? tzRaw : "UTC";
    const startRaw = read(form, "scheduledStart").trim();
    const endRaw = read(form, "scheduledEnd").trim();
    const scheduledStart = startRaw ? zonedLocalToIso(startRaw, tz) : undefined;
    const scheduledEnd = endRaw ? zonedLocalToIso(endRaw, tz) : undefined;
    if (startRaw && !scheduledStart) return { error: "Start: enter a valid date and time." };
    if (endRaw && !scheduledEnd) return { error: "End: enter a valid date and time." };
    const version = Number(read(form, "version"));
    if (!Number.isInteger(version) || version < 1) return { error: "This job changed. Refresh the board and try again." };
    await updateJob(user, read(form, "jobId"), {
      op: "assign",
      version,
      assigneeId: read(form, "assigneeId"),
      scheduledStart,
      scheduledEnd,
    });
    revalidatePath("/board");
    revalidatePath("/jobs");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}
