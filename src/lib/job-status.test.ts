import { describe, expect, it } from "vitest";
import { JOB_STATUSES, isWorkTransition, transitionNeedsNote } from "./job-status";
import { distanceM, normalizeLocation } from "./location";

describe("job status machine", () => {
  it("allows exactly the documented work transitions", () => {
    const allowed: string[] = [];
    for (const a of JOB_STATUSES) for (const b of JOB_STATUSES) if (isWorkTransition(a, b)) allowed.push(`${a}>${b}`);
    expect(allowed.sort()).toEqual(["en_route>on_site", "on_hold>on_site", "on_site>completed", "on_site>on_hold", "scheduled>en_route", "scheduled>on_site"].sort());
  });

  it("needs a note to complete or hold, not to resume", () => {
    expect(transitionNeedsNote("completed")).toBe(true);
    expect(transitionNeedsNote("on_hold")).toBe(true);
    expect(transitionNeedsNote("on_site")).toBe(false);
    expect(transitionNeedsNote("en_route")).toBe(false);
  });
});

describe("location", () => {
  const now = new Date("2026-11-14T12:00:00Z");
  it("rounds to 4 decimals and stores whole metres", () => {
    const l = normalizeLocation({ lat: 30.267153, lng: -97.743061, accuracyM: 24.6, capturedAt: "2026-11-14T11:59:00Z" }, now);
    expect(l).toMatchObject({ lat: "30.2672", lng: "-97.7431", accuracyM: 25, late: false });
  });
  it("flags a fix older than 10 minutes as late, and clamps the device clock to [-7 days, now]", () => {
    expect(normalizeLocation({ lat: 1, lng: 1, accuracyM: 5, capturedAt: "2026-11-14T11:49:00Z" }, now).late).toBe(true);
    const old = normalizeLocation({ lat: 1, lng: 1, accuracyM: 5, capturedAt: "2020-01-01T00:00:00Z" }, now);
    expect(old.capturedAt.toISOString()).toBe("2026-11-07T12:00:00.000Z");
    const future = normalizeLocation({ lat: 1, lng: 1, accuracyM: 5, capturedAt: "2030-01-01T00:00:00Z" }, now);
    expect(future.capturedAt.toISOString()).toBe(now.toISOString());
    expect(future.late).toBe(false);
  });
  it("measures distance with haversine", () => {
    expect(distanceM({ lat: 30, lng: -97 }, { lat: 30, lng: -97 })).toBe(0);
    const d = distanceM({ lat: 30.2672, lng: -97.7431 }, { lat: 30.2681, lng: -97.7431 });
    expect(d).toBeGreaterThan(95);
    expect(d).toBeLessThan(105);
  });
});
