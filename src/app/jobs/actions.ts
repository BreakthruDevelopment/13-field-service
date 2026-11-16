"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ZodError } from "zod";
import { ForbiddenError, UnauthorizedError } from "@/lib/auth/rbac";
import { requireRole } from "@/lib/auth/session";
import { HttpError } from "@/lib/errors";
import { JOB_PRIORITY_LABELS, type JobPriority, isTimeZone, todayInTimeZone, zonedLocalToIso } from "@/lib/job-display";
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

export async function createJobAction(_prev: NewJobState, form: FormData): Promise<NewJobState> {
  const values = valuesOf(form);
  const tz = isTimeZone(values.tz) ? values.tz : "UTC";
  const scheduledStart = values.scheduledStart.trim() ? zonedLocalToIso(values.scheduledStart.trim(), tz) : undefined;
  const scheduledEnd = values.scheduledEnd.trim() ? zonedLocalToIso(values.scheduledEnd.trim(), tz) : undefined;
  if (values.scheduledStart.trim() && !scheduledStart) return { error: "Start: enter a valid date and time.", values };
  if (values.scheduledEnd.trim() && !scheduledEnd) return { error: "End: enter a valid date and time.", values };

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
