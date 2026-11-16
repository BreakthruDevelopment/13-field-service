"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { ForbiddenError, UnauthorizedError } from "@/lib/auth/rbac";
import { requireRole } from "@/lib/auth/session";
import { HttpError, VersionConflictError } from "@/lib/errors";
import { isTimeZone, resolveZonedLocal } from "@/lib/job-display";
import { updateJob } from "@/lib/service-jobs";

/** `conflict` tells the form to refresh the board before the dispatcher tries again. */
export type AssignState = { error?: string; ok?: boolean; conflict?: boolean };

// Only async functions may be exported from a "use server" module, so these stay local.
const CONFLICT_MESSAGE = "This job changed while the form was open. The board has been refreshed — check it before assigning again.";

/** A clock time the zone skips (spring forward) is refused, not quietly moved. See `resolveZonedLocal`. */
const NONEXISTENT_MESSAGE = (field: string) =>
  `${field}: that clock time doesn't exist on this date — the clocks move forward. Pick a time before or after the change.`;

function read(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}

function fail(err: unknown): AssignState {
  if (err instanceof VersionConflictError) return { error: CONFLICT_MESSAGE, conflict: true };
  if (err instanceof ZodError) return { error: err.issues[0]?.message ?? "Check the form and try again." };
  if (err instanceof UnauthorizedError) return { error: "Sign in to continue." };
  if (err instanceof ForbiddenError) return { error: "Only a dispatcher can assign a job." };
  if (err instanceof HttpError && err.status < 500) {
    return { error: err.status === 429 ? "Too many requests, try again in a minute." : err.message };
  }
  throw err;
}

/** The window as an instant, or the error to show for `field`. */
function windowValue(raw: string, tz: string, field: string): { iso?: string } | { error: string } {
  if (!raw) return {};
  const result = resolveZonedLocal(raw, tz);
  if (result.ok) return { iso: result.iso };
  return { error: result.reason === "nonexistent" ? NONEXISTENT_MESSAGE(field) : `${field}: enter a valid date and time.` };
}

export async function assignJobAction(_prev: AssignState, form: FormData): Promise<AssignState> {
  try {
    const user = await requireRole("dispatcher");
    const tzRaw = read(form, "tz");
    const tz = isTimeZone(tzRaw) ? tzRaw : "UTC";
    const start = windowValue(read(form, "scheduledStart").trim(), tz, "Start");
    if ("error" in start) return { error: start.error };
    const end = windowValue(read(form, "scheduledEnd").trim(), tz, "End");
    if ("error" in end) return { error: end.error };
    const version = Number(read(form, "version"));
    if (!Number.isInteger(version) || version < 1) return { error: "This job changed. Refresh the board and try again." };
    const opId = read(form, "clientOpId");
    await updateJob(user, read(form, "jobId"), {
      op: "assign",
      version,
      assigneeId: read(form, "assigneeId"),
      scheduledStart: start.iso,
      scheduledEnd: end.iso,
      // A retry after a lost response replays this id and gets the first assignment back.
      opId: opId || undefined,
    });
    revalidatePath("/board");
    revalidatePath("/jobs");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}
