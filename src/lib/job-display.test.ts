import { describe, expect, it } from "vitest";
import {
  formatWindow,
  isCalendarDate,
  isTimeZone,
  isoToZonedLocal,
  jobPriorityTone,
  jobStatusTone,
  shiftCalendarDate,
  todayInTimeZone,
  zonedLocalToIso,
} from "./job-display";
import { startVisiblePoll } from "./visible-poll";

describe("calendar dates and time zones", () => {
  it("accepts real days and rejects impossible ones", () => {
    expect(isCalendarDate("2026-11-16")).toBe(true);
    expect(isCalendarDate("2026-02-28")).toBe(true);
    expect(isCalendarDate("2026-02-30")).toBe(false);
    expect(isCalendarDate("2026-13-01")).toBe(false);
    expect(isCalendarDate("today")).toBe(false);
  });

  it("accepts IANA names the Intl API knows", () => {
    expect(isTimeZone("UTC")).toBe(true);
    expect(isTimeZone("America/Chicago")).toBe(true);
    expect(isTimeZone("not a zone")).toBe(false);
    expect(isTimeZone("")).toBe(false);
  });

  it("today in UTC is the UTC calendar day", () => {
    expect(todayInTimeZone("UTC", new Date("2026-11-16T01:30:00Z"))).toBe("2026-11-16");
    expect(todayInTimeZone("America/Chicago", new Date("2026-11-16T01:30:00Z"))).toBe("2026-11-15");
  });

  it("shifts a civil date by whole days", () => {
    expect(shiftCalendarDate("2026-11-16", 1)).toBe("2026-11-17");
    expect(shiftCalendarDate("2026-11-01", -1)).toBe("2026-10-31");
  });
});

describe("zoned local datetime", () => {
  it("UTC wall clock is that instant", () => {
    expect(zonedLocalToIso("2026-11-16T09:00", "UTC")).toBe("2026-11-16T09:00:00.000Z");
  });

  it("America/Chicago in November is UTC−6", () => {
    expect(zonedLocalToIso("2026-11-16T09:00", "America/Chicago")).toBe("2026-11-16T15:00:00.000Z");
  });

  it("America/New_York in July is UTC−4", () => {
    expect(zonedLocalToIso("2026-07-16T09:00", "America/New_York")).toBe("2026-07-16T13:00:00.000Z");
  });

  it("round-trips through isoToZonedLocal", () => {
    const iso = zonedLocalToIso("2026-11-16T09:30", "America/Chicago");
    expect(iso).toBeTruthy();
    expect(isoToZonedLocal(iso!, "America/Chicago")).toBe("2026-11-16T09:30");
  });

  it("rejects junk", () => {
    expect(zonedLocalToIso("09:00", "UTC")).toBeNull();
    expect(zonedLocalToIso("2026-11-16T09:00", "nope")).toBeNull();
  });
});

describe("labels", () => {
  it("maps status and priority to badge tones that keep a text label", () => {
    expect(jobStatusTone("unassigned")).toBe("not-started");
    expect(jobStatusTone("scheduled")).toBe("live");
    expect(jobStatusTone("en_route")).toBe("building");
    expect(jobStatusTone("cancelled")).toBe("blocked");
    expect(jobPriorityTone("emergency")).toBe("blocked");
    expect(jobPriorityTone("normal")).toBe("not-started");
  });

  it("formats a window in the shop time zone", () => {
    expect(formatWindow(null, null, "UTC")).toBe("No window");
    expect(formatWindow("2026-11-16T15:00:00.000Z", "2026-11-16T17:00:00.000Z", "UTC")).toMatch(/3:00/);
  });
});

describe("startVisiblePoll", () => {
  function harness(start: "visible" | "hidden") {
    const listeners = new Map<string, () => void>();
    const doc = {
      visibilityState: start,
      addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
      removeEventListener: (type: string) => listeners.delete(type),
    };
    let ticks: Array<() => void> = [];
    const env = {
      document: doc,
      setInterval: (fn: () => void) => {
        ticks.push(fn);
        return ticks.length;
      },
      clearInterval: (_id: number) => {
        ticks = [];
      },
    };
    const calls: number[] = [];
    const stop = startVisiblePoll(() => calls.push(calls.length + 1), env, 60_000);
    return {
      calls,
      fireTick: () => ticks.forEach((fn) => fn()),
      hide: () => {
        doc.visibilityState = "hidden";
        listeners.get("visibilitychange")?.();
      },
      show: () => {
        doc.visibilityState = "visible";
        listeners.get("visibilitychange")?.();
      },
      stop,
      tickCount: () => ticks.length,
    };
  }

  it("does not refresh on start, then refreshes on each visible tick", () => {
    const h = harness("visible");
    expect(h.calls).toEqual([]);
    expect(h.tickCount()).toBe(1);
    h.fireTick();
    h.fireTick();
    expect(h.calls).toEqual([1, 2]);
  });

  it("stops ticking while hidden and refreshes once when it becomes visible", () => {
    const h = harness("visible");
    h.hide();
    expect(h.tickCount()).toBe(0);
    h.fireTick();
    expect(h.calls).toEqual([]);
    h.show();
    expect(h.calls).toEqual([1]);
    expect(h.tickCount()).toBe(1);
    h.fireTick();
    expect(h.calls).toEqual([1, 2]);
  });

  it("cleanup removes the listener and the interval", () => {
    const h = harness("visible");
    h.stop();
    h.fireTick();
    h.show();
    expect(h.calls).toEqual([]);
  });
});
