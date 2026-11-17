import type { JobStatus } from "@/lib/job-status";

export type JobBadgeTone = "live" | "passed" | "building" | "blocked" | "not-started";

/** Labels and date helpers for the dispatcher board and jobs list. Framework-free so tests can run them. */

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  unassigned: "Unassigned",
  scheduled: "Scheduled",
  en_route: "En route",
  on_site: "On site",
  on_hold: "On hold",
  completed: "Completed",
  cancelled: "Cancelled",
};

export const JOB_PRIORITY_LABELS = {
  low: "Low",
  normal: "Normal",
  high: "High",
  emergency: "Emergency",
} as const;

export type JobPriority = keyof typeof JOB_PRIORITY_LABELS;
export const JOB_PRIORITY_VALUES = Object.keys(JOB_PRIORITY_LABELS) as JobPriority[];

export function jobStatusTone(status: JobStatus): JobBadgeTone {
  switch (status) {
    case "scheduled":
    case "on_site":
    case "completed":
      return status === "completed" ? "passed" : "live";
    case "en_route":
    case "on_hold":
      return "building";
    case "cancelled":
      return "blocked";
    default:
      return "not-started";
  }
}

export function jobPriorityTone(priority: JobPriority): JobBadgeTone {
  if (priority === "emergency") return "blocked";
  if (priority === "high") return "building";
  return "not-started";
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** A real Gregorian calendar day, not 2026-02-30. */
export function isCalendarDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const utc = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(utc.getTime()) && utc.toISOString().slice(0, 10) === value;
}

/** IANA name the Intl API accepts, capped like the board query. */
export function isTimeZone(value: string): boolean {
  if (value.length < 1 || value.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function todayInTimeZone(tz: string, now = new Date()): string {
  const zone = isTimeZone(tz) ? tz : "UTC";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function shiftCalendarDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function tzOffsetMs(instant: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - instant.getTime();
}

/**
 * A year a dispatcher could mean. Below this a `datetime-local` value is a mistyped year ("0226" for 2026), which
 * gets the plain "enter a valid date and time" rather than an explanation about daylight saving.
 */
const MIN_YEAR = 1000;

/**
 * The outcome of reading a `datetime-local` value:
 * - `invalid` — not a `YYYY-MM-DDTHH:mm` wall clock on a real day, a year before 1000, or an unusable time zone.
 * - `nonexistent` — a real-looking clock time that the zone skips when the clocks spring forward
 *   (02:30 on 2026-03-08 in America/Chicago). We refuse it rather than silently pick 01:30 or 03:30:
 *   on a dispatch board a quietly shifted window sends a technician to a customer at the wrong hour.
 *   An ambiguous time (the hour that repeats when the clocks fall back) is NOT rejected: both readings
 *   exist, and we take the first (still-DST) one, the same choice the browser and `Temporal` make.
 */
export type ZonedLocalResult = { ok: true; iso: string } | { ok: false; reason: "invalid" | "nonexistent" };

/** Convert a wall-clock `YYYY-MM-DDTHH:mm` in `tz` to an ISO-8601 UTC string, saying why when it can't. */
export function resolveZonedLocal(local: string, tz: string): ZonedLocalResult {
  const m = LOCAL_RE.exec(local);
  if (!m || !isTimeZone(tz)) return { ok: false, reason: "invalid" };
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  if (!isCalendarDate(`${m[1]}-${m[2]}-${m[3]}`) || hour > 23 || minute > 59) return { ok: false, reason: "invalid" };
  if (year < MIN_YEAR) return { ok: false, reason: "invalid" };
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset1 = tzOffsetMs(new Date(wall), tz);
  const offset2 = tzOffsetMs(new Date(wall - offset1), tz);
  const result = new Date(wall - offset2);
  if (Number.isNaN(result.getTime())) return { ok: false, reason: "invalid" };
  const iso = result.toISOString();
  // A skipped clock time has no instant: converting back lands on a different wall clock.
  if (isoToZonedLocal(iso, tz) !== local) return { ok: false, reason: "nonexistent" };
  return { ok: true, iso };
}

/**
 * Convert a wall-clock `YYYY-MM-DDTHH:mm` in `tz` to an ISO-8601 UTC string.
 * Returns null when the local string or time zone is unusable, or the clock time doesn't exist in `tz`.
 */
export function zonedLocalToIso(local: string, tz: string): string | null {
  const result = resolveZonedLocal(local, tz);
  return result.ok ? result.iso : null;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** `YYYY-MM-DDTHH:mm` in `tz` for a datetime-local input. */
export function isoToZonedLocal(iso: string, tz: string): string | null {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime()) || !isTimeZone(tz)) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  // The year is zero-padded like the rest: `datetime-local` wants four digits, and `resolveZonedLocal` compares this
  // string with what it was given, so an unpadded year would read as a clock time the zone skips.
  return `${String(get("year")).padStart(4, "0")}-${pad(get("month"))}-${pad(get("day"))}T${pad(get("hour"))}:${pad(get("minute"))}`;
}

function formatTime(iso: string, tz: string): string {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return "";
  const zone = isTimeZone(tz) ? tz : "UTC";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour: "numeric",
    minute: "2-digit",
  }).format(instant);
}

function formatDate(iso: string, tz: string, withYear: boolean): string {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return "";
  const zone = isTimeZone(tz) ? tz : "UTC";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
  }).format(instant);
}

/** The calendar day an instant falls on in `tz`, as `YYYY-MM-DD`. */
function dayOf(iso: string, tz: string): string {
  const instant = new Date(iso);
  return Number.isNaN(instant.getTime()) ? "" : todayInTimeZone(tz, instant);
}

/**
 * A job's window for a card or a list row, e.g. "9:00 AM–11:00 AM".
 *
 * The date is shown whenever the window is NOT on the day being displayed, and always when no day is given.
 * The board's unassigned tray holds jobs from any date (`getBoard`) and `/jobs` lists every day at once, so a
 * bare clock time there reads as today and sends a technician out on the wrong day.
 * Empty window → "No window".
 */
export function formatWindow(
  start: string | null,
  end: string | null,
  tz: string,
  opts: { onDate?: string | null; now?: Date } = {},
): string {
  if (!start && !end) return "No window";
  const onDate = opts.onDate && isCalendarDate(opts.onDate) ? opts.onDate : null;
  const refYear = (onDate ?? todayInTimeZone(tz, opts.now ?? new Date())).slice(0, 4);
  const label = (iso: string, sameAs: string | null) => {
    const day = dayOf(iso, tz);
    const time = formatTime(iso, tz);
    if (!day || (sameAs && day === sameAs)) return time;
    return `${formatDate(iso, tz, day.slice(0, 4) !== refYear)}, ${time}`;
  };
  if (start && end) {
    // The end repeats its date only when the window runs past midnight.
    return `${label(start, onDate)}–${label(end, dayOf(start, tz))}`;
  }
  return label(start ?? end ?? "", onDate);
}
