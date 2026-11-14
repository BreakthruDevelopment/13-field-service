"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { ForbiddenError, UnauthorizedError } from "@/lib/auth/rbac";
import { requireRole } from "@/lib/auth/session";
import { createDispatchJob } from "@/lib/dispatch";
import { utcToday } from "@/lib/dispatch-view";
import { HttpError } from "@/lib/errors";

export type JobActionState = { error?: string; ok?: boolean; boardDate?: string };

function read(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}

/** Map the new-job form onto the data-function input. An empty select means "create new". */
function inputFromJobForm(form: FormData): unknown {
  const customerId = read(form, "customerId");
  const siteId = read(form, "siteId");
  const assigneeId = read(form, "assigneeId");
  const clientOpId = read(form, "clientOpId");
  const scheduledStart = read(form, "scheduledStart");
  const scheduledEnd = read(form, "scheduledEnd");
  const priority = read(form, "priority") || "normal";
  return {
    clientOpId,
    ...(customerId
      ? { customerId }
      : {
          customer: {
            name: read(form, "customerName"),
            phone: read(form, "customerPhone"),
            email: read(form, "customerEmail"),
            notes: read(form, "customerNotes"),
            clientOpId,
          },
        }),
    ...(siteId
      ? { siteId }
      : {
          site: {
            label: read(form, "siteLabel"),
            address: read(form, "siteAddress"),
            accessNotes: read(form, "siteAccessNotes"),
            clientOpId,
          },
        }),
    title: read(form, "title"),
    description: read(form, "description"),
    priority,
    ...(assigneeId ? { assigneeId } : {}),
    ...(scheduledStart ? { scheduledStart } : {}),
    ...(scheduledEnd ? { scheduledEnd } : {}),
  };
}

export async function createJobAction(_prev: JobActionState, form: FormData): Promise<JobActionState> {
  try {
    const user = await requireRole("dispatcher");
    const job = await createDispatchJob(user, inputFromJobForm(form));
    revalidatePath("/board");
    revalidatePath("/jobs");
    return { ok: true, boardDate: job.scheduledStart ? job.scheduledStart.toISOString().slice(0, 10) : utcToday() };
  } catch (err) {
    if (err instanceof ZodError) return { error: err.issues[0]?.message ?? "Check the form and try again." };
    if (err instanceof UnauthorizedError) return { error: "Sign in to continue." };
    if (err instanceof ForbiddenError) return { error: "Only a dispatcher can schedule jobs." };
    if (err instanceof HttpError && err.status < 500) return { error: err.message };
    throw err;
  }
}
