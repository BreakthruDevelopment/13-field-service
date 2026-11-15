"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { loadDemo, setUserRole } from "@/lib/admin";
import { ForbiddenError, UnauthorizedError } from "@/lib/auth/rbac";
import { requireRole } from "@/lib/auth/session";
import { HttpError } from "@/lib/errors";

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

function fail(err: unknown): AdminActionState {
  if (err instanceof ZodError) return { error: err.issues[0]?.message ?? "Check the form and try again." };
  if (err instanceof UnauthorizedError) return { error: "Sign in to continue." };
  if (err instanceof ForbiddenError) return { error: "Only an admin can do that." };
  if (err instanceof HttpError && err.status < 500) return { error: err.message };
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
    const granted = result.user.role === "user" ? "Waiting for access" : result.user.role;
    const extra =
      result.unassignedJobs > 0
        ? ` ${result.unassignedJobs} open ${result.unassignedJobs === 1 ? "job was" : "jobs were"} moved back to the unassigned tray.`
        : "";
    return { ok: true, message: `Role is now ${granted}.${extra}`, unassignedJobs: result.unassignedJobs };
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
