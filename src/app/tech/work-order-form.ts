import type { WorkOrderDto, WorkOrderEdit } from "./actions";

/**
 * The work-order editor's form, with no React in it: what the technician typed, how it compares to the server's
 * version, and how to read it back to them. `unsavedBeforeReplace` is the one that matters — a version conflict must
 * never throw away words someone typed (decision D5, the same rule the refused-note list follows).
 */

export type TaskForm = { key: string; description: string; state: "done" | "to_do" };
export type LineForm = { key: string; sku: string; mentioned: string; qty: string; unit: string; used: "used" | "needed"; flags: string[] };
export type FormState = { summary: string; followUp: string; tasks: TaskForm[]; lines: LineForm[] };

export const EMPTY_FORM: FormState = { summary: "", followUp: "", tasks: [], lines: [] };

export function fromDto(order: WorkOrderDto): FormState {
  return {
    summary: order.summary,
    followUp: order.followUp ?? "",
    tasks: order.tasks.map((task) => ({ key: crypto.randomUUID(), description: task.description, state: task.state })),
    lines: order.lines.map((line) => ({
      key: crypto.randomUUID(),
      sku: line.sku ?? "",
      mentioned: line.mentioned,
      qty: String(line.qty),
      unit: line.unit,
      used: line.used,
      flags: [...line.flags],
    })),
  };
}

/** Everything the technician can change, with the row keys and the server's flags left out. */
export function canonical(form: FormState): string {
  return JSON.stringify({
    summary: form.summary.trim(),
    followUp: form.followUp.trim(),
    tasks: form.tasks.map((task) => ({ description: task.description.trim(), state: task.state })),
    lines: form.lines.map((line) => ({
      sku: line.sku.trim().toUpperCase(),
      mentioned: line.mentioned.trim(),
      qty: line.qty.trim(),
      unit: line.unit,
      used: line.used,
    })),
  });
}

/**
 * The technician's unsaved text, when a different version from the server is about to replace the form: a stale-version
 * conflict, a reload after reconnecting, or "Draft again". `null` when there is nothing of theirs to keep — nothing was
 * typed, or the server's version already says the same thing.
 */
export function unsavedBeforeReplace(previous: WorkOrderDto | null, typed: FormState, next: WorkOrderDto): FormState | null {
  if (!previous || previous.id !== next.id) return null;
  const words = canonical(typed);
  if (words === canonical(fromDto(previous))) return null;
  if (words === canonical(fromDto(next))) return null;
  return typed;
}

/** The form as plain text, for the technician to read back and copy. */
export function describeForm(form: FormState): string {
  const parts = [`Summary: ${form.summary.trim() || "(none)"}`];
  if (form.tasks.length > 0) {
    parts.push(["Tasks:", ...form.tasks.map((task) => `- ${task.state === "done" ? "Done" : "To do"} — ${task.description.trim() || "(no description)"}`)].join("\n"));
  }
  if (form.lines.length > 0) {
    parts.push(
      [
        "Parts:",
        ...form.lines.map((line) => {
          const sku = line.sku.trim() ? ` · ${line.sku.trim().toUpperCase()}` : "";
          return `- ${line.qty.trim() || "?"} ${line.unit} · ${line.used} · ${line.mentioned.trim() || "(no name)"}${sku}`;
        }),
      ].join("\n"),
    );
  }
  if (form.followUp.trim()) parts.push(`Follow-up: ${form.followUp.trim()}`);
  return parts.join("\n\n");
}

export function parseForm(form: FormState, units: readonly string[]): { ok: true; value: Omit<WorkOrderEdit, "clientOpId" | "version"> } | { ok: false; error: string } {
  const texts = [form.summary, form.followUp, ...form.tasks.map((task) => task.description), ...form.lines.flatMap((line) => [line.mentioned, line.sku])];
  if (texts.some((value) => value.includes("\0"))) return { ok: false, error: "Text can't contain null characters" };
  const summary = form.summary.trim();
  if (summary.length > 400) return { ok: false, error: "Summary is at most 400 characters." };
  const follow = form.followUp.trim();
  if (follow.length > 300) return { ok: false, error: "Follow-up is at most 300 characters." };
  if (form.tasks.length > 12) return { ok: false, error: "A work order has at most 12 tasks." };
  if (form.lines.length > 30) return { ok: false, error: "A work order has at most 30 parts." };
  const tasks: WorkOrderEdit["tasks"] = [];
  for (const task of form.tasks) {
    const description = task.description.trim();
    if (!description) return { ok: false, error: "Each task needs a description." };
    if (description.length > 200) return { ok: false, error: "A task is at most 200 characters." };
    tasks.push({ description, state: task.state });
  }
  const lines: WorkOrderEdit["lines"] = [];
  for (const line of form.lines) {
    const mentioned = line.mentioned.trim();
    if (!mentioned) return { ok: false, error: "Say what the part is." };
    if (mentioned.length > 120) return { ok: false, error: "A part name is at most 120 characters." };
    const qty = Number(line.qty);
    if (!Number.isFinite(qty) || qty <= 0 || qty > 9999) return { ok: false, error: "Enter a quantity greater than 0." };
    if (!units.includes(line.unit)) return { ok: false, error: "Choose a unit." };
    const sku = line.sku.trim();
    if (sku && !/^[A-Za-z0-9-]{2,40}$/.test(sku)) return { ok: false, error: "SKU is 2 to 40 letters, digits or dashes." };
    lines.push({ sku: sku ? sku.toUpperCase() : null, mentioned, qty, unit: line.unit, used: line.used });
  }
  return { ok: true, value: { summary, tasks, followUp: follow ? follow : null, lines } };
}
