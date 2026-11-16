import { describe, expect, it } from "vitest";
import {
  formatWindow,
  isCalendarDate,
  isTimeZone,
  isoToZonedLocal,
  jobPriorityTone,
  jobStatusTone,
  resolveZonedLocal,
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
    expect(resolveZonedLocal("2026-02-30T09:00", "UTC")).toEqual({ ok: false, reason: "invalid" });
  });

  // America/Chicago 2026: forward 02:00 -> 03:00 on Mar 8, back 02:00 -> 01:00 on Nov 1.
  it("refuses a clock time the spring-forward skips instead of moving it an hour", () => {
    expect(resolveZonedLocal("2026-03-08T02:30", "America/Chicago")).toEqual({ ok: false, reason: "nonexistent" });
    expect(zonedLocalToIso("2026-03-08T02:30", "America/Chicago")).toBeNull();
    // The hours either side of the gap are untouched: 01:30 is CST (−6), 03:30 is CDT (−5).
    expect(zonedLocalToIso("2026-03-08T01:30", "America/Chicago")).toBe("2026-03-08T07:30:00.000Z");
    expect(zonedLocalToIso("2026-03-08T03:30", "America/Chicago")).toBe("2026-03-08T08:30:00.000Z");
  });

  it("takes the first reading of an hour the fall-back repeats", () => {
    // 01:30 happens twice: 06:30Z as CDT, then 07:30Z as CST. We keep the earlier instant, and it round-trips.
    const iso = zonedLocalToIso("2026-11-01T01:30", "America/Chicago");
    expect(iso).toBe("2026-11-01T06:30:00.000Z");
    expect(isoToZonedLocal(iso!, "America/Chicago")).toBe("2026-11-01T01:30");
    expect(isoToZonedLocal("2026-11-01T07:30:00.000Z", "America/Chicago")).toBe("2026-11-01T01:30");
  });

  it("handles midnight, including the midnight a DST day starts with", () => {
    expect(zonedLocalToIso("2026-11-16T00:00", "America/Chicago")).toBe("2026-11-16T06:00:00.000Z");
    expect(zonedLocalToIso("2026-03-08T00:30", "America/Chicago")).toBe("2026-03-08T06:30:00.000Z");
    expect(zonedLocalToIso("2026-11-01T00:30", "America/Chicago")).toBe("2026-11-01T05:30:00.000Z");
  });

  it("round-trips either side of a date boundary, where the UTC day differs from the local one", () => {
    for (const local of ["2026-11-16T23:30", "2026-11-16T00:30", "2026-03-07T23:30", "2026-03-08T00:30"]) {
      const iso = zonedLocalToIso(local, "America/Chicago");
      expect(iso).toBeTruthy();
      expect(isoToZonedLocal(iso!, "America/Chicago")).toBe(local);
    }
    // 23:30 local is already the next UTC day.
    expect(zonedLocalToIso("2026-11-16T23:30", "America/Chicago")).toBe("2026-11-17T05:30:00.000Z");
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

describe("formatWindow dates", () => {
  const tz = "America/Chicago";
  const now = new Date("2026-11-16T12:00:00.000Z");
  // 2026-11-17 07:00–08:00 local, the tray job the board showed as a bare "7:00 AM–8:00 AM".
  const start = "2026-11-17T13:00:00.000Z";
  const end = "2026-11-17T14:00:00.000Z";

  it("shows clock times only when the window is on the day being displayed", () => {
    expect(formatWindow(start, end, tz, { onDate: "2026-11-17" })).toBe("7:00 AM–8:00 AM");
  });

  it("shows the date when the window is on another day, as in the unassigned tray", () => {
    expect(formatWindow(start, end, tz, { onDate: "2026-11-16" })).toBe("Nov 17, 7:00 AM–8:00 AM");
  });

  it("always shows the date with no day to compare against, as in the jobs list", () => {
    expect(formatWindow(start, end, tz, { now })).toBe("Nov 17, 7:00 AM–8:00 AM");
    expect(formatWindow(start, null, tz, { now })).toBe("Nov 17, 7:00 AM");
    expect(formatWindow(null, null, tz, { now })).toBe("No window");
  });

  it("repeats the date on the end only when the window runs past midnight", () => {
    expect(formatWindow("2026-11-17T05:30:00.000Z", "2026-11-17T06:30:00.000Z", tz, { now })).toBe(
      "Nov 16, 11:30 PM–Nov 17, 12:30 AM",
    );
  });

  it("adds the year when the window is not in the year being displayed", () => {
    expect(formatWindow("2027-01-02T15:00:00.000Z", "2027-01-02T16:00:00.000Z", tz, { onDate: "2026-11-16" })).toBe(
      "Jan 2, 2027, 9:00 AM–10:00 AM",
    );
  });

  it("ignores a day that isn't a real calendar date", () => {
    expect(formatWindow(start, end, tz, { onDate: "nope", now })).toBe("Nov 17, 7:00 AM–8:00 AM");
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
      clearInterval: () => {
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
