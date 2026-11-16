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
 * Convert a wall-clock `YYYY-MM-DDTHH:mm` in `tz` to an ISO-8601 UTC string.
 * Returns null when the local string or time zone is unusable.
 */
export function zonedLocalToIso(local: string, tz: string): string | null {
  const m = LOCAL_RE.exec(local);
  if (!m || !isTimeZone(tz)) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset1 = tzOffsetMs(new Date(utcGuess), tz);
  let instant = utcGuess - offset1;
  const offset2 = tzOffsetMs(new Date(instant), tz);
  instant = Date.UTC(year, month - 1, day, hour, minute, 0) - offset2;
  const result = new Date(instant);
  if (Number.isNaN(result.getTime())) return null;
  return result.toISOString();
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
  return `${get("year")}-${pad(get("month"))}-${pad(get("day"))}T${pad(get("hour"))}:${pad(get("minute"))}`;
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

/** Short window for a card, e.g. "9:00–11:00 AM". Empty window → "No window". */
export function formatWindow(start: string | null, end: string | null, tz: string): string {
  if (!start && !end) return "No window";
  if (start && end) return `${formatTime(start, tz)}–${formatTime(end, tz)}`;
  return formatTime(start ?? end ?? "", tz);
}
