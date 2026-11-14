import { checkInView, type CheckInView } from "@/lib/check-in";

export const PART_UNITS = ["each", "ft", "m", "box", "roll", "l", "kg", "set"] as const;
export type PartUnit = (typeof PART_UNITS)[number];

export type TechNote = {
  id: string;
  body: string;
  clientAt: string;
  pending?: boolean;
};

export type TechJob = {
  id: string;
  number: number;
  title: string;
  description: string;
  priority: "low" | "normal" | "high" | "emergency";
  status: string;
  statusVersion: number;
  version: number;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  completedAt: string | null;
  customerName: string;
  customerPhone: string;
  siteLabel: string;
  siteAddress: string;
  accessNotes: string;
  siteLat: number | null;
  siteLng: number | null;
  notes: TechNote[];
  checkIn: CheckInView | null;
};

export type WorkOrderLineView = {
  mentioned: string;
  qty: number;
  unit: PartUnit;
  used: "used" | "needed";
};

export type WorkOrderTaskView = { description: string; state: "done" | "to_do" };

export type WorkOrderView = {
  jobId: string;
  status: "draft" | "submitted" | "approved" | "returned";
  summary: string;
  tasks: WorkOrderTaskView[];
  followUp: string;
  lines: WorkOrderLineView[];
  version: number;
  returnReason: string | null;
};

export type OutboxOp = {
  seq: number;
  opId: string;
  kind: "note.add" | "status.set";
  jobId: string;
  clientAt: string;
  body?: string;
  to?: string;
  baseStatusVersion?: number;
  dependsOn?: string | null;
  location?: { lat: number; lng: number; accuracyM: number; capturedAt: string } | null;
};

export type AttentionItem = {
  id: string;
  jobId: string;
  kind: "note.add" | "status.set";
  outcome: "conflict" | "rejected";
  code: string | null;
  tried: string;
  detail: string;
  noteBody: string | null;
  at: string;
};

export type SyncResult = {
  opId: string;
  outcome: "applied" | "replayed" | "conflict" | "rejected" | "deferred";
  code?: string | null;
  job?: { id: string; status: string; statusVersion: number; version: number } | null;
};

const STATUS_LABELS: Record<string, string> = {
  unassigned: "Unassigned",
  scheduled: "Scheduled",
  en_route: "En route",
  on_site: "On site",
  on_hold: "On hold",
  completed: "Completed",
  cancelled: "Cancelled",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export function statusTone(status: string): "live" | "building" | "blocked" | "not-started" {
  if (status === "completed") return "live";
  if (status === "cancelled") return "blocked";
  if (status === "on_hold" || status === "en_route" || status === "on_site") return "building";
  return "not-started";
}

export function priorityLabel(priority: string): string | null {
  if (priority === "high") return "High";
  if (priority === "emergency") return "Emergency";
  if (priority === "low") return "Low";
  return null;
}

/** A technician status change. `noteRequired` means the server will reject it until a note exists. */
export function transitionAllowed(
  from: string,
  to: string,
  noteCount: number,
): { ok: boolean; noteRequired: boolean } {
  const allowed: Record<string, string[]> = {
    scheduled: ["en_route", "on_site"],
    en_route: ["on_site"],
    on_site: ["completed", "on_hold"],
    on_hold: ["on_site"],
  };
  if (!(allowed[from] ?? []).includes(to)) return { ok: false, noteRequired: false };
  const noteRequired = to === "completed" || to === "on_hold" || (to === "on_site" && from === "on_hold");
  if (noteRequired && noteCount < 1) return { ok: false, noteRequired: true };
  return { ok: true, noteRequired: false };
}

export type StatusAction = {
  to: "en_route" | "on_site" | "on_hold" | "completed";
  label: string;
  checkIn: boolean;
  disabled: boolean;
  reason: string | null;
};

/** Buttons for the job page. Check-in is the only path to on site, so location stays on that tap. */
export function statusActions(status: string, noteCount: number): StatusAction[] {
  const candidates: { to: StatusAction["to"]; label: string; checkIn: boolean }[] = [];
  if (status === "scheduled") candidates.push({ to: "en_route", label: "En route", checkIn: false });
  if (status === "scheduled" || status === "en_route") {
    candidates.push({ to: "on_site", label: "Check in at site", checkIn: true });
  }
  if (status === "on_site") {
    candidates.push({ to: "on_hold", label: "On hold", checkIn: false });
    candidates.push({ to: "completed", label: "Complete", checkIn: false });
  }
  if (status === "on_hold") candidates.push({ to: "on_site", label: "Back on site", checkIn: true });
  return candidates.map((action) => {
    const rule = transitionAllowed(status, action.to, noteCount);
    return {
      ...action,
      disabled: !rule.ok,
      reason: rule.noteRequired ? "Add a note first." : null,
    };
  });
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** Today, then upcoming, then recent. A job is in one group. Active work stays in Today. */
export function groupJobs(jobs: TechJob[], now: Date): { today: TechJob[]; upcoming: TechJob[]; recent: TechJob[] } {
  const todayKey = dayKey(now);
  const today: TechJob[] = [];
  const upcoming: TechJob[] = [];
  const recent: TechJob[] = [];
  for (const job of jobs) {
    if (job.status === "en_route" || job.status === "on_site" || job.status === "on_hold") {
      today.push(job);
      continue;
    }
    if (job.status === "completed" || job.status === "cancelled") {
      recent.push(job);
      continue;
    }
    const start = job.scheduledStart ? new Date(job.scheduledStart) : null;
    if (!start || Number.isNaN(start.getTime()) || dayKey(start) === todayKey || start.getTime() <= now.getTime()) {
      today.push(job);
      continue;
    }
    upcoming.push(job);
  }
  const byStart = (a: TechJob, b: TechJob) => {
    const as = a.scheduledStart ? new Date(a.scheduledStart).getTime() : Number.MAX_SAFE_INTEGER;
    const bs = b.scheduledStart ? new Date(b.scheduledStart).getTime() : Number.MAX_SAFE_INTEGER;
    return as - bs;
  };
  today.sort(byStart);
  upcoming.sort(byStart);
  recent.sort((a, b) => (b.completedAt ?? b.scheduledStart ?? "").localeCompare(a.completedAt ?? a.scheduledStart ?? ""));
  return { today, upcoming, recent };
}

export function formatWindow(start: string | null, end: string | null): string {
  if (!start) return "No time set";
  const s = new Date(start);
  if (Number.isNaN(s.getTime())) return "No time set";
  const day = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" });
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
  if (!end) return `${day.format(s)} · ${time.format(s)}`;
  const e = new Date(end);
  if (Number.isNaN(e.getTime())) return `${day.format(s)} · ${time.format(s)}`;
  return `${day.format(s)} · ${time.format(s)}–${time.format(e)}`;
}

export function attentionDetail(code: string | null, kind: "note.add" | "status.set", serverStatus?: string | null): string {
  const server = serverStatus ? ` The job is now ${statusLabel(serverStatus)}.` : "";
  switch (code) {
    case "not_assigned":
      return kind === "note.add"
        ? "This job is no longer assigned to you. The note is kept here so you can copy it."
        : "This job is no longer assigned to you, so the status change was not saved.";
    case "note_required":
      return "Add a note on the job before that status change.";
    case "bad_transition":
      return `That status change isn't allowed from the job's current state.${server}`;
    case "op_id_reused":
      return "This change was already sent with different details.";
    case "too_many_notes":
      return "This job has as many notes as it can hold.";
    case "location_not_allowed":
      return "A location can only be sent with Check in at site.";
    case "depends_on":
      return `An earlier status change on this job was not saved, so this one was not either.${server}`;
    case "stale_version":
      return `The office changed this job before the status could be saved.${server}`;
    default:
      return kind === "note.add"
        ? `The note could not be saved.${server}`
        : `The status change could not be saved.${server}`;
  }
}

export function syncLabel(input: {
  offline: boolean;
  syncing: boolean;
  pending: number;
  attention: number;
  needsSignIn: boolean;
}): string {
  if (input.needsSignIn) return "Sign in again to sync";
  if (input.offline && input.pending > 0) return `Offline · ${input.pending} waiting`;
  if (input.offline) return "Offline";
  if (input.syncing) return "Syncing…";
  if (input.attention > 0) return `Needs attention · ${input.attention}`;
  if (input.pending > 0) return `${input.pending} waiting to sync`;
  return "Saved";
}

export { checkInView };
