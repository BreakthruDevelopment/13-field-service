import { ConflictError } from "@/lib/errors";

/**
 * The job status machine, framework-free so the dispatcher data layer and the offline sync (13.2) share one set of rules.
 *
 * Technician transitions (also what a dispatcher's `status` op may do):
 *   scheduled -> en_route, scheduled -> on_site, en_route -> on_site, on_site -> completed, on_site <-> on_hold.
 * `completed` and `on_hold` need at least one note on the job (any author; checked on the server, so a note earlier in
 * the same sync batch counts). Resuming from `on_hold` needs no note.
 * Dispatcher-only ops: create, assign / reassign / unassign, reschedule, cancel (any non-final job), reopen
 * (`completed` or `on_hold` -> `scheduled`).
 */
export const JOB_STATUSES = ["unassigned", "scheduled", "en_route", "on_site", "on_hold", "completed", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Not finished: can still be assigned, rescheduled or cancelled. */
export const OPEN_STATUSES: readonly JobStatus[] = ["unassigned", "scheduled", "en_route", "on_site", "on_hold"];
/** Has a technician working it. */
export const ACTIVE_STATUSES: readonly JobStatus[] = ["scheduled", "en_route", "on_site", "on_hold"];
export const FINAL_STATUSES: readonly JobStatus[] = ["completed", "cancelled"];

export const WORK_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  unassigned: [],
  scheduled: ["en_route", "on_site"],
  en_route: ["on_site"],
  on_site: ["completed", "on_hold"],
  on_hold: ["on_site"],
  completed: [],
  cancelled: [],
};

export function isWorkTransition(from: JobStatus, to: JobStatus): boolean {
  return WORK_TRANSITIONS[from].includes(to);
}

export function transitionNeedsNote(to: JobStatus): boolean {
  return to === "completed" || to === "on_hold";
}

/** Why a status change was refused. `code` is stable; the sync endpoint maps it to `conflict` or `rejected`. */
export type StatusRuleCode = "transition_not_allowed" | "note_required" | "job_closed";

export class StatusRuleError extends ConflictError {
  constructor(
    readonly code: StatusRuleCode,
    message: string,
  ) {
    super(message);
  }
}
