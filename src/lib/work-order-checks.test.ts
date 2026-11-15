import { describe, expect, it } from "vitest";
import { type CatalogPart, checkLines, mentionAppears, redactContact, safetyChips, squash } from "./work-order-checks";

const part = (sku: string, unit: CatalogPart["unit"] = "each", maxPerJob = 20): CatalogPart => ({ id: `id-${sku}`, sku, name: sku, unit, maxPerJob });
const catalog = (...ps: CatalogPart[]) => new Map(ps.map((p) => [p.sku, p] as const));

describe("mention matching", () => {
  it("ignores case, spaces and punctuation", () => {
    expect(squash("1/2-IN. Copper")).toBe("12incopper");
    expect(mentionAppears("1/2 in copper elbows", "Replaced 2 x 1/2in copper elbows and 3 ft of PEX")).toBe(true);
    expect(mentionAppears("shutoff valve", "Shutoff   VALVE is seized")).toBe(true);
    expect(mentionAppears("water heater", "Replaced a faucet")).toBe(false);
    expect(mentionAppears("!!!", "anything")).toBe(false);
  });
});

describe("checkLines", () => {
  const row = (o: Partial<Parameters<typeof checkLines>[0][number]> = {}) => ({ sku: "A-1", mentioned: "elbow", qty: 2, unit: "each" as const, used: "used" as const, ...o });
  const opts = { catalog: catalog(part("A-1")), sourceText: "two elbow fittings" };

  it("keeps a verified part with no flags", () => {
    const { lines, dropped } = checkLines([row()], opts);
    expect(dropped).toEqual([]);
    expect(lines).toEqual([{ partId: "id-A-1", sku: "A-1", mentioned: "elbow", qty: 2, unit: "each", used: "used", flags: [] }]);
  });

  it("nulls a SKU that isn't a verified candidate and flags it, never matching by name", () => {
    const { lines } = checkLines([row({ sku: "INVENTED-9", mentioned: "elbow" })], opts);
    expect(lines[0]).toMatchObject({ partId: null, sku: null, flags: ["unknown_part"] });
    expect(checkLines([row({ sku: null })], opts).lines[0]).toMatchObject({ partId: null, flags: ["unknown_part"] });
  });

  it("is case-insensitive on the SKU", () => {
    expect(checkLines([row({ sku: "a-1" })], opts).lines[0].partId).toBe("id-A-1");
  });

  it("drops a row whose words aren't in the job text and lists it", () => {
    const { lines, dropped } = checkLines([row(), row({ sku: null, mentioned: "thermostat" })], opts);
    expect(lines).toHaveLength(1);
    expect(dropped).toEqual([{ mentioned: "thermostat", reason: "not_in_notes" }]);
  });

  it("skips the mention check for human lines (sourceText null)", () => {
    expect(checkLines([row({ sku: null, mentioned: "anything" })], { catalog: catalog(), sourceText: null }).lines).toHaveLength(1);
  });

  it("flags a unit mismatch and never converts", () => {
    const { lines } = checkLines([row({ sku: "C-1", mentioned: "cable", qty: 10, unit: "m" })], { catalog: catalog(part("C-1", "ft")), sourceText: "ran 10 m of cable" });
    expect(lines[0]).toMatchObject({ qty: 10, unit: "m", flags: ["unit_mismatch"] });
  });

  it("flags fractional counts of whole units and quantities over the limit", () => {
    const src = "elbow";
    expect(checkLines([row({ qty: 1.5 })], { ...opts, sourceText: src }).lines[0].flags).toEqual(["non_integer"]);
    expect(checkLines([row({ sku: "P", unit: "ft", qty: 2.5 })], { catalog: catalog(part("P", "ft")), sourceText: src.concat(" elbow") }).lines[0].flags).toEqual([]);
    expect(checkLines([row({ qty: 21 })], opts).lines[0].flags).toEqual(["qty_check"]);
    expect(checkLines([row({ sku: "WH", qty: 100 })], { catalog: catalog(part("WH", "each", 2)), sourceText: "elbow" }).lines[0].flags).toEqual(["qty_check"]);
    expect(checkLines([row({ sku: null, qty: 21 })], opts).lines[0].flags).toEqual(["unknown_part", "qty_check"]);
  });

  it("merges duplicates of the same part, unit and used, and checks the merged quantity", () => {
    const { lines } = checkLines([row({ qty: 12 }), row({ qty: 12 }), row({ used: "needed" }), row({ unit: "box" })], opts);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ qty: 24, flags: ["qty_check"] });
  });

  it("never merges lines that aren't catalog parts", () => {
    expect(checkLines([row({ sku: null }), row({ sku: null })], opts).lines).toHaveLength(2);
  });

  it("keeps a tiny positive quantity above zero (the database requires qty > 0)", () => {
    expect(checkLines([row({ qty: 0.001 })], opts).lines[0].qty).toBe(0.01);
  });
});

describe("safetyChips", () => {
  it("names the phrase that matched", () => {
    expect(safetyChips("Tenant says there's a gas smell near the water heater")).toEqual([{ code: "gas", phrase: "gas smell" }]);
    expect(safetyChips("CO alarm went off")).toEqual([{ code: "carbon_monoxide", phrase: "CO alarm" }]);
    expect(safetyChips("Found a live wire in the junction box")[0]).toMatchObject({ code: "live_wire", phrase: "live wire" });
    expect(safetyChips("possible asbestos tile")).toEqual([{ code: "asbestos", phrase: "asbestos" }]);
  });
  it("flags flooding only near electrics", () => {
    expect(safetyChips("Basement flooded, water reached the breaker panel")).toEqual([{ code: "flooding_near_electrics", phrase: "flooded" }]);
    expect(safetyChips("Basement flooded, pumped it out")).toEqual([]);
  });
  it("stays quiet on ordinary notes", () => {
    expect(safetyChips("Replaced 2 x 1/2in copper elbows and 3 ft of PEX. Gas line untouched.")).toEqual([]);
  });
});

describe("redactContact", () => {
  it("masks emails and phone numbers but not part sizes", () => {
    expect(redactContact("call Sam on 555-010-1234 or sam@example.com")).toBe("call Sam on [phone] or [email]");
    expect(redactContact("(512) 555-0100 and +1 512.555.0100")).toBe("[phone] and [phone]");
    expect(redactContact("5125550187, +15125550187 and (512)555-0187 and 1-512-555-0187")).toBe("[phone], [phone] and [phone] and [phone]");
    expect(redactContact("PO 51255501870 and 1/2in x 5125550187/2")).toBe("PO 51255501870 and 1/2in x 5125550187/2");
    expect(redactContact("Ran 14/2 cable, 1/2in PEX, 20x25x1 filter, 3 ft")).toBe("Ran 14/2 cable, 1/2in PEX, 20x25x1 filter, 3 ft");
  });
});
