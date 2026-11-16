import type { JobStatus, QueuedOp, SyncResult, TechJob, TechNote, WireOp } from "./types";

/**
 * The status rules the phone checks before it queues anything, mirroring `src/lib/job-status.ts` on the server (which
 * stays the authority: a queued op the server refuses ends up in "Needs attention"). `rules.test.ts` compares the two
 * tables so they can't drift.
 */
export const WORK_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  unassigned: [],
  scheduled: ["en_route", "on_site"],
  en_route: ["on_site"],
  on_site: ["completed", "on_hold"],
  on_hold: ["on_site"],
  completed: [],
  cancelled: [],
};

export const isWorkTransition = (from: JobStatus, to: JobStatus) => WORK_TRANSITIONS[from].includes(to);
export const transitionNeedsNote = (to: JobStatus) => to === "completed" || to === "on_hold";

export const MAX_NOTE_LENGTH = 2000;

/** A refusal the phone can make without the network. `code` is stable (the UI switches on it). */
export class LocalRuleError extends Error {
  constructor(
    readonly code: "no_such_job" | "job_cancelled" | "transition_not_allowed" | "note_required" | "empty_note" | "note_too_long" | "location_only_on_site",
    message: string,
  ) {
    super(message);
    this.name = "LocalRuleError";
  }
}

/** Trim, drop NUL bytes (Postgres can't store them and the server would refuse the batch), and check the length. */
export function cleanNote(body: string): string {
  const cleaned = body.replace(/\0/g, "").trim();
  if (!cleaned) throw new LocalRuleError("empty_note", "Note is empty");
  if (cleaned.length > MAX_NOTE_LENGTH) throw new LocalRuleError("note_too_long", `Notes are at most ${MAX_NOTE_LENGTH} characters`);
  return cleaned;
}

/**
 * The jobs as the technician should see them right now: the server's snapshot with every queued op applied on top, in
 * order. A queued `status.set` raises the local `statusVersion` (so the next status op carries the raised base), a queued
 * note shows up marked `pending`. Pure: the snapshot and the outbox are untouched.
 */
export function overlay(jobs: TechJob[], queue: QueuedOp[]): TechJob[] {
  const out = jobs.map((j) => ({ ...j, notes: [...j.notes], pendingOps: 0 }));
  const byId = new Map(out.map((j) => [j.id, j]));
  for (const { op } of queue) {
    const job = byId.get(op.jobId);
    if (!job) continue;
    job.pendingOps = (job.pendingOps ?? 0) + 1;
    if (op.kind === "note.add") {
      const note: TechNote = { id: `local-${op.opId}`, body: op.body, clientAt: op.clientAt, serverAt: op.clientAt, byMe: true, pending: true };
      job.notes.push(note);
    } else {
      job.status = op.to;
      job.statusVersion = op.baseStatusVersion + 1;
      if (op.to === "completed") job.completedAt = op.clientAt;
    }
  }
  return out;
}

/**
 * Fold the server's final answers into the saved snapshot, so that removing an acknowledged op from the outbox never
 * makes the screen fall back to older data (the next snapshot fetch can fail or be slow). For every answered op:
 * - the job's `status`, `statusVersion` and `version` become the server's when the answer carries its state and that
 *   state is not older than what is saved (a replay returns the state at the time of the first answer);
 * - an `applied` or `replayed` note is added (by its server id) unless it is already there.
 * A refused op changes nothing except taking the server's state from its answer. Pure.
 */
export function applyAcknowledged(jobs: TechJob[], answered: { op: WireOp; result: SyncResult }[], nowIso: string): TechJob[] {
  const out = jobs.map((j) => ({ ...j, notes: [...j.notes] }));
  const byId = new Map(out.map((j) => [j.id, j]));
  for (const { op, result } of answered) {
    const job = byId.get(op.jobId);
    if (!job) continue;
    const brief = result.job;
    if (brief && brief.id === job.id && (brief.statusVersion > job.statusVersion || (brief.statusVersion === job.statusVersion && brief.version >= job.version))) {
      job.status = brief.status;
      job.statusVersion = brief.statusVersion;
      job.version = brief.version;
      if (brief.status === "completed" && !job.completedAt) job.completedAt = nowIso;
    }
    const ok = result.outcome === "applied" || result.outcome === "replayed";
    if (ok && op.kind === "note.add" && result.noteId && !job.notes.some((n) => n.id === result.noteId)) {
      job.notes.push({ id: result.noteId, body: op.body, clientAt: op.clientAt, serverAt: nowIso, byMe: true });
    }
  }
  return out;
}
