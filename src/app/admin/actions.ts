"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { loadDemo, setUserRole } from "@/lib/admin";
import { ForbiddenError, UnauthorizedError } from "@/lib/auth/rbac";
import { requireRole } from "@/lib/auth/session";
import { HttpError, VersionConflictError } from "@/lib/errors";

export type AdminActionState = {
  error?: string;
  ok?: boolean;
  message?: string;
  unassignedJobs?: number;
};

function read(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}

const ROLE_NAMES: Record<string, string> = {
  user: "waiting for access",
  technician: "a Technician",
  dispatcher: "a Dispatcher",
  admin: "an Admin",
};

function fail(err: unknown): AdminActionState {
  if (err instanceof VersionConflictError) {
    const current = (err.current as { role?: string } | null)?.role ?? "";
    const label = ROLE_NAMES[current];
    return {
      error: label
        ? `This person is now ${label}. Your change wasn't applied; check the role and save again.`
        : "This person's role changed. Your change wasn't applied; check the role and save again.",
    };
  }
  if (err instanceof ZodError) return { error: err.issues[0]?.message ?? "Check the form and try again." };
  if (err instanceof UnauthorizedError) return { error: "Sign in to continue." };
  if (err instanceof ForbiddenError) return { error: "Only an admin can do that." };
  if (err instanceof HttpError && err.status < 500) {
    return { error: err.status === 429 ? "Too many requests, try again in a minute." : err.message };
  }
  throw err;
}

function refreshAdmin() {
  revalidatePath("/admin");
}

export async function setRoleAction(_prev: AdminActionState, form: FormData): Promise<AdminActionState> {
  try {
    const user = await requireRole("admin");
    const clientOpId = read(form, "clientOpId");
    const result = await setUserRole(user, {
      userId: read(form, "userId"),
      role: read(form, "role"),
      from: read(form, "from"),
      clientOpId: clientOpId || undefined,
    });
    refreshAdmin();
    const granted = result.user.role === "user" ? "waiting for access" : result.user.role;
    const extra =
      result.unassignedJobs > 0
        ? ` ${result.unassignedJobs} open ${result.unassignedJobs === 1 ? "job was" : "jobs were"} moved back to the unassigned tray.`
        : "";
    const lead = result.replayed
      ? `That click was already applied (a repeat, nothing changed again). Role is ${granted}.`
      : `Role is now ${granted}.`;
    return { ok: true, message: `${lead}${extra}`, unassignedJobs: result.unassignedJobs };
  } catch (err) {
    return fail(err);
  }
}

export async function loadDemoAction(_prev: AdminActionState, form: FormData): Promise<AdminActionState> {
  try {
    const user = await requireRole("admin");
    const clientOpId = read(form, "clientOpId");
    const demo = await loadDemo(user, { clientOpId: clientOpId || undefined });
    refreshAdmin();
    if (demo.replayed) return { ok: true, message: "That click already loaded the demo. Nothing was reloaded." };
    return {
      ok: true,
      message: `Loaded ${demo.dispatchers} dispatchers, ${demo.technicians} technicians, ${demo.customers} customers, ${demo.sites} sites, ${demo.parts} parts and ${demo.jobs} jobs.`,
    };
  } catch (err) {
    return fail(err);
  }
}
