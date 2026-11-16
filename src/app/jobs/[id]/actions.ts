"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/session";
import { JOB_PRIORITIES } from "@/lib/db/schema";
import { type ActionState, actionFailure, read, versionOf } from "@/lib/form-errors";
import { JOB_STATUSES } from "@/lib/job-status";
import { addJobNote, updateJob } from "@/lib/service-jobs";
import { updateWorkOrder } from "@/lib/work-orders";

const LABELS: Record<string, string> = {
  title: "Title",
  description: "Description",
  priority: "Priority",
  assigneeId: "Technician",
  body: "Note",
  reason: "What to fix",
  to: "Status",
};

function revalidateJob(id: string, customerId: string) {
  revalidatePath(`/jobs/${id}`);
  if (customerId) revalidatePath(`/customers/${customerId}`);
}

function stale(): ActionState {
  return { error: "This page is out of date. Reload it and try again." };
}

export async function updateJobAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const version = versionOf(form);
  if (!version) return stale();
  const id = read(form, "id");
  const customerId = read(form, "customerId");
  const op = read(form, "op");
  try {
    const user = await requireRole("dispatcher");
    if (op === "assign") {
      const start = read(form, "scheduledStart").trim();
      const end = read(form, "scheduledEnd").trim();
      if ((start === "") !== (end === "")) return { error: "Give both a start and an end, or leave both blank to keep the current window." };
      await updateJob(user, id, {
        op: "assign",
        version,
        assigneeId: read(form, "assigneeId"),
        ...(start && end ? { scheduledStart: start, scheduledEnd: end } : {}),
      });
    } else if (op === "unassign") {
      await updateJob(user, id, { op: "unassign", version });
    } else if (op === "reschedule") {
      const start = read(form, "scheduledStart").trim();
      const end = read(form, "scheduledEnd").trim();
      if (!start || !end) return { error: "Give both a start and an end. The window can be at most 12 hours." };
      await updateJob(user, id, { op: "reschedule", version, scheduledStart: start, scheduledEnd: end });
    } else if (op === "status") {
      const to = read(form, "to");
      if (!(JOB_STATUSES as readonly string[]).includes(to)) return { error: "That status isn't available." };
      await updateJob(user, id, { op: "status", version, to: to as (typeof JOB_STATUSES)[number] });
    } else if (op === "cancel") {
      if (read(form, "confirm") !== "on") return { error: "Confirm that you want to cancel this job." };
      await updateJob(user, id, { op: "cancel", version });
    } else if (op === "reopen") {
      await updateJob(user, id, { op: "reopen", version });
    } else if (op === "edit") {
      const priority = read(form, "priority");
      if (!(JOB_PRIORITIES as readonly string[]).includes(priority)) return { error: "Choose a priority." };
      await updateJob(user, id, {
        op: "edit",
        version,
        title: read(form, "title"),
        description: read(form, "description"),
        priority: priority as (typeof JOB_PRIORITIES)[number],
      });
    } else {
      return { error: "That action isn't available." };
    }
    revalidateJob(id, customerId);
    return { ok: true };
  } catch (err) {
    return actionFailure(err, LABELS);
  }
}

export async function addNoteAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = read(form, "id");
  const customerId = read(form, "customerId");
  try {
    const user = await requireRole("dispatcher");
    const opId = read(form, "opId");
    await addJobNote(user, id, { body: read(form, "body"), opId: opId || undefined });
    revalidateJob(id, customerId);
    return { ok: true };
  } catch (err) {
    return actionFailure(err, LABELS);
  }
}

export async function workOrderAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const version = versionOf(form);
  if (!version) return stale();
  const clientOpId = read(form, "clientOpId");
  if (!clientOpId) return stale();
  const id = read(form, "id");
  const customerId = read(form, "customerId");
  const op = read(form, "op");
  try {
    const user = await requireRole("dispatcher");
    if (op === "approve") {
      await updateWorkOrder(user, id, { op: "approve", clientOpId, version });
    } else if (op === "return") {
      await updateWorkOrder(user, id, { op: "return", clientOpId, version, reason: read(form, "reason") });
    } else {
      return { error: "That action isn't available." };
    }
    revalidateJob(id, customerId);
    return { ok: true };
  } catch (err) {
    return actionFailure(err, LABELS);
  }
}
