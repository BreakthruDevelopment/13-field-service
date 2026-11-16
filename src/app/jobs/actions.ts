"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ZodError } from "zod";
import { ForbiddenError, UnauthorizedError } from "@/lib/auth/rbac";
import { requireRole } from "@/lib/auth/session";
import { HttpError } from "@/lib/errors";
import { JOB_PRIORITY_LABELS, type JobPriority, isTimeZone, resolveZonedLocal, todayInTimeZone } from "@/lib/job-display";
import { createJob } from "@/lib/service-jobs";

export type NewJobValues = {
  customerId: string;
  siteId: string;
  title: string;
  description: string;
  priority: string;
  assigneeId: string;
  scheduledStart: string;
  scheduledEnd: string;
  tz: string;
};

export type NewJobState = { error?: string; ok?: boolean; values?: NewJobValues };

const FIELD_LABELS: Record<string, string> = {
  customerId: "Customer",
  siteId: "Site",
  title: "Title",
  description: "Description",
  priority: "Priority",
  assigneeId: "Technician",
  scheduledStart: "Start",
  scheduledEnd: "End",
};

function read(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}

function valuesOf(form: FormData): NewJobValues {
  return {
    customerId: read(form, "customerId"),
    siteId: read(form, "siteId"),
    title: read(form, "title"),
    description: read(form, "description"),
    priority: read(form, "priority") || "normal",
    assigneeId: read(form, "assigneeId"),
    scheduledStart: read(form, "scheduledStart"),
    scheduledEnd: read(form, "scheduledEnd"),
    tz: read(form, "tz") || "UTC",
  };
}

function zodMessage(err: ZodError): string {
  const issue = err.issues[0];
  if (!issue) return "Check the form and try again.";
  const key = String(issue.path[0] ?? "");
  const label = FIELD_LABELS[key];
  if (!label) return issue.message;
  return issue.message.toLowerCase().startsWith(label.toLowerCase()) ? issue.message : `${label}: ${issue.message}`;
}

function fail(err: unknown, values?: NewJobValues): NewJobState {
  if (err instanceof ZodError) return { error: zodMessage(err), values };
  if (err instanceof UnauthorizedError) return { error: "Sign in to continue.", values };
  if (err instanceof ForbiddenError) return { error: "Only a dispatcher can create a job.", values };
  if (err instanceof HttpError && err.status < 500) {
    return { error: err.status === 429 ? "Too many requests, try again in a minute." : err.message, values };
  }
  throw err;
}

/** The window as an instant, or the error to show for `field`. A skipped clock time is refused, not quietly moved. */
function windowValue(raw: string, tz: string, field: string): { iso?: string } | { error: string } {
  if (!raw) return {};
  const result = resolveZonedLocal(raw, tz);
  if (result.ok) return { iso: result.iso };
  return {
    error:
      result.reason === "nonexistent"
        ? `${field}: that clock time doesn't exist on this date — the clocks move forward. Pick a time before or after the change.`
        : `${field}: enter a valid date and time.`,
  };
}

export async function createJobAction(_prev: NewJobState, form: FormData): Promise<NewJobState> {
  const values = valuesOf(form);
  const tz = isTimeZone(values.tz) ? values.tz : "UTC";
  const start = windowValue(values.scheduledStart.trim(), tz, "Start");
  if ("error" in start) return { error: start.error, values };
  const end = windowValue(values.scheduledEnd.trim(), tz, "End");
  if ("error" in end) return { error: end.error, values };
  const scheduledStart = start.iso;
  const scheduledEnd = end.iso;

  const priority = (Object.keys(JOB_PRIORITY_LABELS) as JobPriority[]).includes(values.priority as JobPriority)
    ? (values.priority as JobPriority)
    : "normal";
  const clientOpId = read(form, "clientOpId");

  let job;
  try {
    const user = await requireRole("dispatcher");
    ({ job } = await createJob(user, {
      customerId: values.customerId,
      siteId: values.siteId,
      title: values.title,
      description: values.description,
      priority,
      assigneeId: values.assigneeId.trim() || undefined,
      scheduledStart,
      scheduledEnd,
      clientOpId: clientOpId || undefined,
    }));
  } catch (err) {
    return fail(err, values);
  }
  revalidatePath("/board");
  revalidatePath("/jobs");
  const day = job.scheduledStart ? todayInTimeZone(tz, new Date(job.scheduledStart)) : todayInTimeZone(tz);
  redirect(`/board?date=${day}&tz=${encodeURIComponent(tz)}`);
}
