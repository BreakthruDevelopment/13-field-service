import { type SQL, eq } from "drizzle-orm";
import { type Actor, ForbiddenError } from "@/lib/auth/rbac";
import { serviceJob } from "@/lib/db/schema";

/**
 * The access rules, in one table. The template's `can()` (admin passes everything) is not used: here every role sees a
 * different slice, and admin sees only counts and roles. Every data function calls `assertCan()` first.
 *
 * | Role        | Can                                                                                              |
 * | ----------- | ------------------------------------------------------------------------------------------------ |
 * | user        | nothing (a new sign-up waits on `/waiting` until an admin grants a role)                         |
 * | technician  | jobs with `assignee_id = actor.id`, plus their notes, events and work order (draft, edit, submit); |
 * |             | the customer name/phone and site of those jobs come through the job; read the parts catalog.     |
 * |             | Customers, sites and the board are not readable on their own.                                    |
 * | dispatcher  | customers, sites, jobs, notes, events, parts, the board, work orders (all: draft, edit, approve,  |
 * |             | return); never `/api/sync` or `/api/my/jobs` (the `sync` resource is the technician's alone)     |
 * | admin       | `stats`, `user_directory` (read) and `role` (update) and `demo` only; no job, customer or        |
 * |             | location content                                                                                 |
 *
 * Two layers:
 * - `assertCan(actor, action, resource)` answers "can this role ever do this to this kind of thing" (403 when not).
 * - For a technician, row access is "this job is assigned to me". Queries add `jobScope(actor)` so a job that is
 *   someone else's (or doesn't exist) matches zero rows, and the caller answers 404 for both: ids can't be probed.
 *   Passing the row (`{ assigneeId }`) to `assertCan` checks the same rule a second time.
 */

/**
 * `submit` and `approve` are the work-order review steps (decision D4): the technician submits their own order, a
 * dispatcher approves or returns it. Neither role holds the other's action.
 */
export type Action = "read" | "create" | "update" | "delete" | "submit" | "approve";

export type Resource =
  | "customer"
  | "site"
  | "job"
  | "job_note"
  | "job_event"
  | "part"
  | "board"
  | "work_order"
  | "sync"
  | "stats"
  | "user_directory"
  | "role"
  | "demo";

type Rule = Partial<Record<Resource, readonly Action[]>>;

const ALL: readonly Action[] = ["read", "create", "update", "delete"];

const RULES: Record<Actor["role"], Rule> = {
  user: {},
  technician: {
    job: ["read"],
    job_note: ["read", "create"],
    job_event: ["read"],
    part: ["read"],
    work_order: ["read", "create", "update", "submit"],
    // The offline channel (13.2): `read` is GET /api/my/jobs (the snapshot), `create` is POST /api/sync. Technicians only.
    sync: ["read", "create"],
  },
  dispatcher: {
    customer: ALL,
    site: ALL,
    job: ["read", "create", "update"],
    job_note: ["read", "create"],
    job_event: ["read"],
    part: ["read", "create", "update"],
    board: ["read"],
    work_order: ["read", "create", "update", "approve"],
  },
  admin: {
    stats: ["read"],
    user_directory: ["read"],
    role: ["update"],
    demo: ["create"],
  },
};

/** Technician-owned resources: row access needs the job's assignee to be the actor. */
const ASSIGNEE_SCOPED: readonly Resource[] = ["job", "job_note", "job_event", "work_order"];

/** Pure check. `row` is the job the resource hangs off; technicians need `row.assigneeId === actor.id`. */
export function can(actor: Actor, action: Action, resource: Resource, row?: { assigneeId: string | null }): boolean {
  if (!(RULES[actor.role]?.[resource] ?? []).includes(action)) return false;
  if (actor.role === "technician" && ASSIGNEE_SCOPED.includes(resource) && row !== undefined) {
    return row.assigneeId === actor.id;
  }
  return true;
}

/** Throws `ForbiddenError` (403) unless `can()` allows it. Call it before touching data. */
export function assertCan(actor: Actor, action: Action, resource: Resource, row?: { assigneeId: string | null }): void {
  if (!can(actor, action, resource, row)) throw new ForbiddenError();
}

/**
 * The SQL fragment every job query ANDs in: a technician sees only their own jobs, a dispatcher sees all. Other roles
 * never get this far (`assertCan` refuses them first); if one does, the fragment matches nothing.
 */
export function jobScope(actor: Actor): SQL | undefined {
  if (actor.role === "dispatcher") return undefined;
  if (actor.role === "technician") return eq(serviceJob.assigneeId, actor.id);
  return eq(serviceJob.id, "00000000-0000-0000-0000-000000000000");
}
