"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { ForbiddenError, UnauthorizedError } from "@/lib/auth/rbac";
import { requireRole } from "@/lib/auth/session";
import { HttpError } from "@/lib/errors";
import { createPart, updatePart } from "@/lib/parts";

export type PartActionState = { error?: string; ok?: boolean };

function read(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}

function parseAliases(raw: string): string[] {
  return raw
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 10);
}

function fail(err: unknown): PartActionState {
  if (err instanceof ZodError) return { error: err.issues[0]?.message ?? "Check the form and try again." };
  if (err instanceof UnauthorizedError) return { error: "Sign in to continue." };
  if (err instanceof ForbiddenError) return { error: "Only a dispatcher can change the catalog." };
  if (err instanceof HttpError && err.status < 500) return { error: err.message };
  throw err;
}

export async function createPartAction(_prev: PartActionState, form: FormData): Promise<PartActionState> {
  try {
    const user = await requireRole("dispatcher");
    const maxRaw = read(form, "maxPerJob");
    const clientOpId = read(form, "clientOpId");
    await createPart(user, {
      sku: read(form, "sku"),
      name: read(form, "name"),
      unit: read(form, "unit") || "each",
      aliases: parseAliases(read(form, "aliases")),
      maxPerJob: maxRaw ? Number(maxRaw) : 20,
      clientOpId: clientOpId || undefined,
    });
    revalidatePath("/parts");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function updatePartAction(_prev: PartActionState, form: FormData): Promise<PartActionState> {
  try {
    const user = await requireRole("dispatcher");
    const id = read(form, "id");
    const patch: Record<string, unknown> = { version: Number(read(form, "version")) };
    if (form.has("name")) patch.name = read(form, "name");
    if (form.has("unit")) patch.unit = read(form, "unit");
    if (form.has("aliases")) patch.aliases = parseAliases(read(form, "aliases"));
    if (form.has("maxPerJob")) {
      const n = Number(read(form, "maxPerJob"));
      if (Number.isFinite(n)) patch.maxPerJob = n;
    }
    if (form.has("active")) patch.active = read(form, "active") === "true";
    await updatePart(user, id, patch);
    revalidatePath("/parts");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}
