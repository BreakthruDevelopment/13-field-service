import type { Status } from "@/components/ui/StatusBadge";
import { LocalRuleError, WORK_TRANSITIONS } from "@/lib/offline/rules";
import type { AttentionItem, JobStatus, SyncStatus, TechJob } from "@/lib/offline/types";

/** User-typed text, including a 60-character string with no spaces, wraps inside a 375px page. */
export const userTextClass = "min-w-0 break-words [overflow-wrap:anywhere]";

/** How `/tech` groups the snapshot. Closed jobs are recent even if the window was today. */
export type JobBucket = "today" | "upcoming" | "recent";

const CLOSED: readonly JobStatus[] = ["completed", "cancelled"];
const ACTIVE: readonly JobStatus[] = ["en_route", "on_site", "on_hold"];

// Word for word the same map as JOB_STATUS_LABELS in #18 (src/lib/job-display.ts) and #19 (src/lib/field-format.ts):
// duplication, not technician-specific wording. The three become one shared map in the rebase planned for these PRs.
export const STATUS_LABEL: Record<JobStatus, string> = {
  unassigned: "Unassigned",
  scheduled: "Scheduled",
  en_route: "En route",
  on_site: "On site",
  on_hold: "On hold",
  completed: "Completed",
  cancelled: "Cancelled",
};

export const GROUP_META: readonly { id: JobBucket; title: string; empty: string }[] = [
  { id: "today", title: "Today", empty: "Nothing scheduled for today." },
  { id: "upcoming", title: "Upcoming", empty: "Nothing upcoming in the next two weeks." },
  { id: "recent", title: "Recent", empty: "No jobs completed or cancelled in the last three days." },
];

/** Local calendar day, so a job at 11pm stays on that day in the technician's timezone. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function jobBucket(job: TechJob, now: Date): JobBucket {
  if (CLOSED.includes(job.status)) return "recent";
  if (ACTIVE.includes(job.status)) return "today";
  if (!job.scheduledStart) return "today";
  const start = new Date(job.scheduledStart);
  if (Number.isNaN(start.getTime())) return "today";
  return dayKey(start) > dayKey(now) ? "upcoming" : "today";
}

/** Group a snapshot for the list. Does not reorder the caller's array. */
export function groupJobs(jobs: readonly TechJob[], now: Date): Record<JobBucket, TechJob[]> {
  const groups: Record<JobBucket, TechJob[]> = { today: [], upcoming: [], recent: [] };
  for (const job of jobs) groups[jobBucket(job, now)].push(job);
  const rank = (job: TechJob) => (ACTIVE.includes(job.status) ? 0 : 1);
  groups.today.sort((a, b) => rank(a) - rank(b) || (a.scheduledStart ?? "").localeCompare(b.scheduledStart ?? "") || a.number - b.number);
  groups.upcoming.sort((a, b) => (a.scheduledStart ?? "").localeCompare(b.scheduledStart ?? "") || a.number - b.number);
  groups.recent.sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? "") || b.number - a.number);
  return groups;
}

export function formatWindow(start: string | null, end: string | null): string {
  if (!start) return "No time set";
  const s = new Date(start);
  if (Number.isNaN(s.getTime())) return "No time set";
  const date = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" }).format(s);
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(s);
  if (!end) return `${date}, ${time}`;
  const e = new Date(end);
  if (Number.isNaN(e.getTime())) return `${date}, ${time}`;
  const endTime = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(e);
  return `${date}, ${time}–${endTime}`;
}

export function formatClock(ms: number): string {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(ms));
}

export function changeCount(n: number): string {
  return `${n} ${n === 1 ? "change" : "changes"}`;
}

export function jobStatusBadge(status: JobStatus): { status: Status; label: string } {
  switch (status) {
    case "en_route":
      return { status: "building", label: STATUS_LABEL.en_route };
    case "on_site":
      return { status: "live", label: STATUS_LABEL.on_site };
    case "on_hold":
      return { status: "degraded", label: STATUS_LABEL.on_hold };
    case "completed":
      return { status: "passed", label: STATUS_LABEL.completed };
    case "cancelled":
      return { status: "blocked", label: STATUS_LABEL.cancelled };
    default:
      return { status: "not-started", label: STATUS_LABEL[status] };
  }
}

export function priorityBadge(priority: TechJob["priority"]): { status: Status; label: string } | null {
  if (priority === "emergency") return { status: "blocked", label: "Emergency" };
  if (priority === "high") return { status: "building", label: "High" };
  return null;
}

export function priorityLabel(priority: TechJob["priority"]): string {
  if (priority === "low") return "Low";
  if (priority === "high") return "High";
  if (priority === "emergency") return "Emergency";
  return "Normal";
}

export type StatusButton = { to: JobStatus; label: string; checkIn: boolean };

/** The status buttons for one job. `on_site` is always the "Check in at site" tap. */
export function statusButtons(from: JobStatus): StatusButton[] {
  return WORK_TRANSITIONS[from].map((to) => ({
    to,
    checkIn: to === "on_site",
    label: to === "on_site" ? "Check in at site" : to === "en_route" ? "En route" : to === "on_hold" ? "On hold" : to === "completed" ? "Complete" : STATUS_LABEL[to],
  }));
}

/** The phone already knows a note is required. `notesTruncated` means the server has older notes that are not in the snapshot. */
export function needsNoteFirst(job: TechJob, to: JobStatus): boolean {
  return (to === "completed" || to === "on_hold") && job.notes.length === 0 && !job.notesTruncated;
}

export function syncChip(input: { ready: boolean; online: boolean; status: SyncStatus; pending: number }): { label: string; tone: Status } {
  if (!input.ready) return { label: "Loading", tone: "not-started" };
  if (!input.online) {
    return { label: input.pending > 0 ? `Offline · ${changeCount(input.pending)} waiting` : "Offline", tone: "building" };
  }
  switch (input.status) {
    case "syncing":
      return { label: "Syncing", tone: "building" };
    case "backoff":
      return { label: "Will retry", tone: "building" };
    case "signed_out":
      return { label: "Sign in to sync", tone: "blocked" };
    case "forbidden":
      return { label: "Can't sync", tone: "blocked" };
    case "wiped":
      return { label: "Signed out", tone: "blocked" };
    default:
      return input.pending > 0
        ? { label: `${changeCount(input.pending)} waiting to sync`, tone: "building" }
        : { label: "Up to date", tone: "live" };
  }
}

export function attentionHeading(item: AttentionItem): string {
  if (item.op.kind === "note.add") return `${item.label}: note not saved`;
  return `${item.label}: not changed to ${STATUS_LABEL[item.op.to]}`;
}

/** What Needs attention says. A refused note's words stay in the list (decision D5). */
export function attentionDetail(item: AttentionItem): string {
  const note = item.op.kind === "note.add";
  switch (item.code) {
    case "not_assigned":
      return note
        ? "This job is no longer yours, so the note was not saved. Copy it if you still need the words."
        : "This job is no longer yours, so the status change was not saved.";
    case "stale_version":
    case "dependency_unmet":
      return "The office changed this job while you were offline, so this status change was not applied.";
    case "job_cancelled":
      return "This job was cancelled.";
    case "note_required":
      return "Add a note on the job before that status change.";
    case "note_limit":
      return "This job already has as many notes as it can hold.";
    case "op_id_reused":
      return "That change was already sent with different details.";
    case "invalid_op":
      return "That change wasn't valid, so it was not applied.";
    default:
      return note ? "The note was not saved." : "The status change was not applied.";
  }
}

export function attentionNoteBody(item: AttentionItem): string | null {
  return item.op.kind === "note.add" ? item.op.body : null;
}

export function attentionServerStatus(item: AttentionItem): string | null {
  if (!item.job) return null;
  return `On the server: ${STATUS_LABEL[item.job.status]}`;
}

/** A link the technician opens. No map tiles and no geocoding request from the app. */
export function openStreetMapUrl(site: { address: string; lat: number | null; lng: number | null }): string | null {
  if (site.lat != null && site.lng != null && Number.isFinite(site.lat) && Number.isFinite(site.lng)) {
    const lat = site.lat.toFixed(5);
    const lng = site.lng.toFixed(5);
    return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`;
  }
  const address = site.address.trim();
  if (!address) return null;
  return `https://www.openstreetmap.org/search?query=${encodeURIComponent(address)}`;
}

export const FLAG_LABEL: Record<string, string> = {
  unknown_part: "Not in the catalog",
  unit_mismatch: "Unit differs from the catalog",
  non_integer: "Use a whole number for this unit",
  qty_check: "Quantity is above the usual amount for this part",
};

/** A message the technician can read. Anything else stays generic so a storage error never shows internals. */
export function phoneError(err: unknown): string {
  if (err instanceof LocalRuleError) return err.message;
  if (err instanceof Error && err.message === "Offline storage isn't ready") {
    return "This phone isn't ready to save changes yet. Wait a moment and try again.";
  }
  return "Couldn't save that on this phone. Try again.";
}
