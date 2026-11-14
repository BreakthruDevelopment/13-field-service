import type { JobPriority, ServiceJobStatus } from "@/lib/db/schema";
import type { Status } from "@/components/ui";

/** Status badge tone for a dispatch job. The label is the job status, not the badge's default word. */
export function jobStatusTone(status: ServiceJobStatus): Status {
  switch (status) {
    case "unassigned":
      return "not-started";
    case "scheduled":
    case "en_route":
      return "building";
    case "on_site":
      return "live";
    case "on_hold":
      return "degraded";
    case "completed":
      return "healthy";
    case "cancelled":
      return "blocked";
  }
}

const STATUS_LABELS: Record<ServiceJobStatus, string> = {
  unassigned: "Unassigned",
  scheduled: "Scheduled",
  en_route: "En route",
  on_site: "On site",
  on_hold: "On hold",
  completed: "Completed",
  cancelled: "Cancelled",
};

const PRIORITY_LABELS: Record<JobPriority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  emergency: "Emergency",
};

export function jobStatusLabel(status: ServiceJobStatus): string {
  return STATUS_LABELS[status];
}

export function jobPriorityLabel(priority: JobPriority): string {
  return PRIORITY_LABELS[priority];
}

/** `YYYY-MM-DD` for today in UTC. The board day is a UTC calendar date. */
export function utcToday(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Accept a real `YYYY-MM-DD` calendar day, otherwise today (UTC). Feb 31 is rejected, not rolled over. */
export function parseUtcDay(value: string | undefined, now = new Date()): string {
  if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value) return value;
  }
  return utcToday(now);
}

export function shiftUtcDay(day: string, delta: number): string {
  const t = new Date(`${day}T00:00:00.000Z`);
  t.setUTCDate(t.getUTCDate() + delta);
  return t.toISOString().slice(0, 10);
}

/** Inclusive start and exclusive end of a UTC calendar day, as ISO timestamps. */
export function utcDayBounds(day: string): { start: Date; end: Date } {
  const start = new Date(`${day}T00:00:00.000Z`);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

const HOUR_MS = 60 * 60 * 1000;
export const MAX_WINDOW_MS = 12 * HOUR_MS;

/**
 * Parse a dispatcher time. `datetime-local` values (`YYYY-MM-DDTHH:mm`) are read as UTC,
 * matching the label on the form. Full ISO timestamps pass through.
 */
export function parseUtcInstant(value: string): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const local = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::\d{2})?$/.exec(trimmed);
  const iso = local ? `${local[1]}:00.000Z` : trimmed;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return null;
  return new Date(time);
}

export function formatWindow(start: Date | null, end: Date | null): string {
  if (!start || !end) return "No time set";
  const day = start.toISOString().slice(0, 10);
  const a = start.toISOString().slice(11, 16);
  const b = end.toISOString().slice(11, 16);
  const endDay = end.toISOString().slice(0, 10);
  return endDay === day ? `${day} ${a}–${b} UTC` : `${day} ${a} – ${endDay} ${b} UTC`;
}

/** True when the window overlaps the UTC day. A missing window does not. */
export function windowOverlapsUtcDay(start: Date | null, end: Date | null, day: string): boolean {
  if (!start || !end) return false;
  const bounds = utcDayBounds(day);
  return start.getTime() < bounds.end.getTime() && end.getTime() > bounds.start.getTime();
}
