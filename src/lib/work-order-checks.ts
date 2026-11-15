import { PART_UNITS } from "@/lib/db/schema";

/**
 * The server-side checks every work-order line passes before it reaches the database (13.3). Pure and framework-free: the
 * AI draft, a human edit and the eval suite all use them, so a model's answer is never trusted on its own.
 *
 * - A SKU that isn't a catalog part the server verified is dropped to `null` and flagged `unknown_part`: no part id is
 *   ever invented or guessed from a name.
 * - An AI row whose `mentioned` words don't appear in the job text is dropped and listed (`not_in_notes`).
 * - Units are never converted: a mismatch is kept and flagged. Quantities are never "fixed" either, only flagged.
 */

export type PartUnit = (typeof PART_UNITS)[number];
export type Used = "used" | "needed";

export const LINE_FLAGS = ["unknown_part", "unit_mismatch", "non_integer", "qty_check"] as const;
export type LineFlag = (typeof LINE_FLAGS)[number];

/** A catalog part as the server read it from the database. */
export type CatalogPart = { id: string; sku: string; name: string; unit: PartUnit; maxPerJob: number };

export type DraftRow = { sku: string | null; mentioned: string; qty: number; unit: PartUnit; used: Used };
export type CheckedLine = {
  partId: string | null;
  sku: string | null;
  mentioned: string;
  qty: number;
  unit: PartUnit;
  used: Used;
  flags: LineFlag[];
};
export type DroppedRow = { mentioned: string; reason: "not_in_notes" };

/** Parts that are counted in whole pieces: a fractional quantity of these is flagged. */
export const WHOLE_UNITS: readonly PartUnit[] = ["each", "box", "set"];
/** The most of a part not in the catalog that goes unflagged (a catalog part uses its own `max_per_job`). */
export const UNKNOWN_PART_MAX_QTY = 20;

/** Lower case, letters and digits only: "1/2 in" and "1/2in" and "1/2-IN." all become "12in". */
export function squash(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Whether the technician's words appear in the job text, ignoring case, spaces and punctuation. */
export function mentionAppears(mentioned: string, sourceText: string): boolean {
  const m = squash(mentioned);
  return m.length > 0 && squash(sourceText).includes(m);
}

const round2 = (n: number) => Math.max(0.01, Math.round(n * 100) / 100);

export type CheckOptions = {
  /** Verified catalog parts by upper-case SKU. Only parts the server read from the database; for an AI draft, only those it sent as candidates. */
  catalog: ReadonlyMap<string, CatalogPart>;
  /** The job text the model saw (description and notes). `null` skips the `mentioned` check, for lines a person typed. */
  sourceText: string | null;
};

/** Run every row through the checks. Order is kept; merged duplicates keep the first position. */
export function checkLines(rows: readonly DraftRow[], opts: CheckOptions): { lines: CheckedLine[]; dropped: DroppedRow[] } {
  const dropped: DroppedRow[] = [];
  const kept: { part: CatalogPart | null; row: DraftRow; qty: number }[] = [];
  const byKey = new Map<string, (typeof kept)[number]>();
  for (const row of rows) {
    const mentioned = row.mentioned.trim();
    if (opts.sourceText !== null && !mentionAppears(mentioned, opts.sourceText)) {
      dropped.push({ mentioned: mentioned.slice(0, 120), reason: "not_in_notes" });
      continue;
    }
    const part = row.sku ? (opts.catalog.get(row.sku.trim().toUpperCase()) ?? null) : null;
    // The same catalog part, unit and used/needed is one line: quantities add up.
    const key = part ? `${part.id}|${row.unit}|${row.used}` : null;
    const existing = key ? byKey.get(key) : undefined;
    if (existing) {
      existing.qty += row.qty;
      continue;
    }
    const entry = { part, row: { ...row, mentioned }, qty: row.qty };
    kept.push(entry);
    if (key) byKey.set(key, entry);
  }
  const lines = kept.map(({ part, row, qty }): CheckedLine => {
    const q = round2(qty);
    const flags: LineFlag[] = [];
    if (!part) flags.push("unknown_part");
    if (part && part.unit !== row.unit) flags.push("unit_mismatch");
    if (WHOLE_UNITS.includes(row.unit) && !Number.isInteger(q)) flags.push("non_integer");
    if (q > (part?.maxPerJob ?? UNKNOWN_PART_MAX_QTY)) flags.push("qty_check");
    return { partId: part?.id ?? null, sku: part?.sku ?? null, mentioned: row.mentioned, qty: q, unit: row.unit, used: row.used, flags };
  });
  return { lines, dropped };
}

// ---------------------------------------------------------------------------
// Safety chips
// ---------------------------------------------------------------------------

export type SafetyChip = { code: "gas" | "carbon_monoxide" | "live_wire" | "asbestos" | "flooding_near_electrics"; phrase: string };

const SAFETY_PATTERNS: { code: SafetyChip["code"]; re: RegExp }[] = [
  { code: "gas", re: /\b(?:smell(?:s|ed)?\s+(?:of\s+|like\s+)?gas|gas\s+(?:smell|odou?r|leak)s?|leaking\s+gas|natural\s+gas\s+leak)\b/i },
  { code: "carbon_monoxide", re: /\b(?:carbon\s+monoxide|co\s+(?:alarm|detector|reading|leak)s?)\b/i },
  { code: "live_wire", re: /\b(?:live|hot|energi[sz]ed|exposed|bare)\s+(?:wires?|wiring|conductors?)\b/i },
  { code: "asbestos", re: /\basbestos\b/i },
];
const FLOOD = /\b(?:flood(?:ed|ing|s)?|standing\s+water)\b/i;
const ELECTRICS = /\b(?:outlets?|receptacles?|panels?|breakers?|electrical|wiring|junction\s+box(?:es)?|transformers?)\b/i;

/** A keyword filter over the job text, never the model: "Safety: check before closing" chips naming the phrase that matched. */
export function safetyChips(text: string): SafetyChip[] {
  const chips: SafetyChip[] = [];
  for (const { code, re } of SAFETY_PATTERNS) {
    const m = re.exec(text);
    if (m) chips.push({ code, phrase: m[0].replace(/\s+/g, " ").slice(0, 60) });
  }
  const flood = FLOOD.exec(text);
  if (flood && ELECTRICS.test(text)) chips.push({ code: "flooding_near_electrics", phrase: flood[0].replace(/\s+/g, " ").slice(0, 60) });
  return chips;
}

// ---------------------------------------------------------------------------
// Keeping contact details out of the prompt
// ---------------------------------------------------------------------------

/** Customer name, phone and address are never selected for the prompt; this also masks an email or phone number someone typed into a note. */
export function redactContact(s: string): string {
  return s
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    // Ten digits with or without a +1, spaces, dots, dashes or a bracketed area code. Not inside a longer number or a fraction (14/2, 1/2in).
    .replace(/(?<![\d/])(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?![\d/])/g, "[phone]");
}
