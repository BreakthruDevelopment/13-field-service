import { describe, expect, it } from "vitest";
import { formatWindow, parseUtcDay, parseUtcInstant, shiftUtcDay, windowOverlapsUtcDay } from "./dispatch-view";

describe("board dates", () => {
  it("keeps a real calendar day and falls back to today", () => {
    const now = new Date("2026-11-14T23:30:00.000Z");
    expect(parseUtcDay("2026-11-01", now)).toBe("2026-11-01");
    expect(parseUtcDay("nope", now)).toBe("2026-11-14");
    expect(parseUtcDay("2026-02-31", now)).toBe("2026-11-14");
    expect(shiftUtcDay("2026-11-14", 1)).toBe("2026-11-15");
    expect(shiftUtcDay("2026-11-14", -1)).toBe("2026-11-13");
  });

  it("reads a datetime-local value as UTC and overlaps only that day", () => {
    const start = parseUtcInstant("2026-11-14T15:00");
    const end = parseUtcInstant("2026-11-14T17:00");
    expect(start?.toISOString()).toBe("2026-11-14T15:00:00.000Z");
    expect(windowOverlapsUtcDay(start, end, "2026-11-14")).toBe(true);
    expect(windowOverlapsUtcDay(start, end, "2026-11-15")).toBe(false);
    expect(windowOverlapsUtcDay(null, null, "2026-11-14")).toBe(false);
    expect(formatWindow(start, end)).toBe("2026-11-14 15:00–17:00 UTC");
  });
});
