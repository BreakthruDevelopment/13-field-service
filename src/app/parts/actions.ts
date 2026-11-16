"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { ForbiddenError, UnauthorizedError } from "@/lib/auth/rbac";
import { requireRole } from "@/lib/auth/session";
import { HttpError, VersionConflictError } from "@/lib/errors";
import { createPart, updatePart } from "@/lib/parts";

export type PartValues = { sku: string; name: string; unit: string; aliases: string; maxPerJob: string };
export type PartActionState = { error?: string; ok?: boolean; values?: PartValues };

const FIELD_LABELS: Record<string, string> = {
  sku: "SKU",
  name: "Name",
  unit: "Unit",
  aliases: "Aliases",
  maxPerJob: "Max per job",
};

/** A validation message that names the field, so a long form says which input to fix. */
function zodMessage(err: ZodError): string {
  const issue = err.issues[0];
  if (!issue) return "Check the form and try again.";
  const key = String(issue.path[0] ?? "");
  const label = FIELD_LABELS[key];
  if (key === "aliases") {
    return typeof issue.path[1] === "number" || issue.code === "too_big"
      ? "Aliases: use up to 10 aliases, each 1 to 60 characters."
      : `Aliases: ${issue.message}`;
  }
  if (key === "maxPerJob") return "Max per job: enter a whole number from 1 to 9999.";
  if (!label) return issue.message;
  return issue.message.toLowerCase().startsWith(label.toLowerCase()) ? issue.message : `${label}: ${issue.message}`;
}

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

function fail(err: unknown, values?: PartValues): PartActionState {
  if (err instanceof ZodError) return { error: zodMessage(err), values };
  if (err instanceof VersionConflictError) {
    return {
      error: "Someone else changed this part. The latest values were reloaded; review them and save again.",
      values,
    };
  }
  if (err instanceof UnauthorizedError) return { error: "Sign in to continue." };
  if (err instanceof ForbiddenError) return { error: "Only a dispatcher can change the catalog." };
  if (err instanceof HttpError && err.status < 500) {
    return { error: err.status === 429 ? "Too many requests, try again in a minute." : err.message, values };
  }
  throw err;
}

export async function createPartAction(_prev: PartActionState, form: FormData): Promise<PartActionState> {
  const values: PartValues = {
    sku: read(form, "sku"),
    name: read(form, "name"),
    unit: read(form, "unit") || "each",
    aliases: read(form, "aliases"),
    maxPerJob: read(form, "maxPerJob"),
  };
  try {
    const maxRaw = values.maxPerJob.trim();
    const user = await requireRole("dispatcher");
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
    return fail(err, values);
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
      // Empty means "leave it as it is": the data function has no null, and 0 would be rejected.
      const raw = read(form, "maxPerJob").trim();
      if (raw) patch.maxPerJob = Number(raw);
    }
    if (form.has("active")) patch.active = read(form, "active") === "true";
    await updatePart(user, id, patch);
    revalidatePath("/parts");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}
