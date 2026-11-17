import { describe, expect, it } from "vitest";
import type { WorkOrderDto } from "./actions";
import { canonical, describeForm, fromDto, parseForm, unsavedBeforeReplace, type FormState } from "./work-order-form";

const UNITS = ["each", "ft", "box"] as const;

function order(overrides: Partial<WorkOrderDto> = {}): WorkOrderDto {
  return {
    id: "wo-1",
    jobId: "job-1",
    version: 1,
    status: "draft",
    summary: "Replaced the cartridge.",
    followUp: null,
    returnReason: null,
    tasks: [{ description: "Swap the cartridge", state: "done" }],
    lines: [
      { id: "l1", partId: null, sku: "CART-12", partName: null, mentioned: "cartridge", qty: 1, unit: "each", used: "used", source: "human", flags: [], position: 0 },
    ],
    safety: [],
    ai: null,
    submittedBy: null,
    approvedBy: null,
    createdAt: "2026-11-16T00:00:00.000Z",
    updatedAt: "2026-11-16T00:00:00.000Z",
    ...overrides,
  };
}

describe("unsavedBeforeReplace", () => {
  it("keeps what the technician typed when the server's version replaces the form", () => {
    const previous = order();
    const typed: FormState = { ...fromDto(previous), summary: "MY OWN SUMMARY THAT I HAVE NOT SAVED YET" };
    const next = order({ version: 2, summary: "SERVER SIDE SUMMARY FROM ANOTHER DEVICE" });

    const held = unsavedBeforeReplace(previous, typed, next);

    expect(held?.summary).toBe("MY OWN SUMMARY THAT I HAVE NOT SAVED YET");
  });

  it("keeps edited tasks and part lines, not only the summary", () => {
    const previous = order();
    const base = fromDto(previous);
    const typed: FormState = {
      ...base,
      tasks: [...base.tasks, { key: "k", description: "Bled the line", state: "to_do" }],
      lines: base.lines.map((line) => ({ ...line, qty: "3" })),
    };

    const held = unsavedBeforeReplace(previous, typed, order({ version: 2 }));

    expect(held?.tasks.map((task) => task.description)).toEqual(["Swap the cartridge", "Bled the line"]);
    expect(held?.lines[0].qty).toBe("3");
  });

  it("keeps nothing when the form was untouched", () => {
    const previous = order();
    expect(unsavedBeforeReplace(previous, fromDto(previous), order({ version: 2, summary: "theirs" }))).toBeNull();
  });

  it("keeps nothing when the server's version already says the same thing", () => {
    const previous = order();
    const typed: FormState = { ...fromDto(previous), summary: "Replaced the cartridge and tested it." };
    const next = order({ version: 2, summary: "Replaced the cartridge and tested it." });
    expect(unsavedBeforeReplace(previous, typed, next)).toBeNull();
  });

  it("keeps nothing when there was no work order to edit, or it is a different one", () => {
    const typed: FormState = { summary: "typed", followUp: "", tasks: [], lines: [] };
    expect(unsavedBeforeReplace(null, typed, order())).toBeNull();
    expect(unsavedBeforeReplace(order({ id: "wo-other" }), typed, order())).toBeNull();
  });

  it("ignores whitespace-only differences, so nothing is kept for them", () => {
    const previous = order();
    const typed: FormState = { ...fromDto(previous), summary: "  Replaced the cartridge.  " };
    expect(unsavedBeforeReplace(previous, typed, order({ version: 2 }))).toBeNull();
    expect(canonical(typed)).toBe(canonical(fromDto(previous)));
  });
});

describe("describeForm", () => {
  it("reads back everything the technician typed", () => {
    const form: FormState = {
      summary: "Replaced the cartridge.",
      followUp: "Order a spare.",
      tasks: [{ key: "a", description: "Swap the cartridge", state: "done" }],
      lines: [{ key: "b", sku: "cart-12", mentioned: "cartridge", qty: "2", unit: "each", used: "used", flags: [] }],
    };

    expect(describeForm(form)).toBe(
      ["Summary: Replaced the cartridge.", "", "Tasks:", "- Done — Swap the cartridge", "", "Parts:", "- 2 each · used · cartridge · CART-12", "", "Follow-up: Order a spare."].join("\n"),
    );
  });

  it("says so when there is no summary, and leaves out empty sections", () => {
    expect(describeForm({ summary: "   ", followUp: "", tasks: [], lines: [] })).toBe("Summary: (none)");
  });
});

describe("parseForm", () => {
  it("trims, upper-cases the SKU and makes the quantity a number", () => {
    const parsed = parseForm(
      {
        summary: "  done  ",
        followUp: "  ",
        tasks: [{ key: "a", description: " fix ", state: "to_do" }],
        lines: [{ key: "b", sku: " cart-12 ", mentioned: " cartridge ", qty: " 2 ", unit: "each", used: "used", flags: [] }],
      },
      UNITS,
    );

    expect(parsed).toEqual({
      ok: true,
      value: { summary: "done", followUp: null, tasks: [{ description: "fix", state: "to_do" }], lines: [{ sku: "CART-12", mentioned: "cartridge", qty: 2, unit: "each", used: "used" }] },
    });
  });

  it("refuses NUL bytes, an empty task, a bad quantity and an unknown unit", () => {
    const base: FormState = { summary: "", followUp: "", tasks: [], lines: [] };
    expect(parseForm({ ...base, summary: "a\0b" }, UNITS)).toEqual({ ok: false, error: "Text can't contain null characters" });
    expect(parseForm({ ...base, tasks: [{ key: "a", description: "  ", state: "to_do" }] }, UNITS)).toEqual({ ok: false, error: "Each task needs a description." });
    const line = { key: "b", sku: "", mentioned: "pipe", qty: "0", unit: "each", used: "used" as const, flags: [] };
    expect(parseForm({ ...base, lines: [line] }, UNITS)).toEqual({ ok: false, error: "Enter a quantity greater than 0." });
    expect(parseForm({ ...base, lines: [{ ...line, qty: "1", unit: "furlong" }] }, UNITS)).toEqual({ ok: false, error: "Choose a unit." });
  });
});
