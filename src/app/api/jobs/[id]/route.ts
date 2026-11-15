import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { getJob, updateJob } from "@/lib/service-jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 25;

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/jobs/:id (dispatcher: any job; technician: own job, else 404) -> { job: JobDetail } */
export async function GET(_request: Request, ctx: Ctx) {
  try {
    const user = await requireRole("dispatcher", "technician");
    return Response.json({ job: await getJob(user, (await ctx.params).id) });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * PATCH /api/jobs/:id (dispatcher). Body is one op, always with the `version` last seen:
 *   { op: "assign", version, assigneeId, scheduledStart?, scheduledEnd? } | { op: "unassign", version }
 *   | { op: "reschedule", version, scheduledStart, scheduledEnd } | { op: "status", version, to }
 *   | { op: "cancel", version } | { op: "reopen", version } | { op: "edit", version, title?, description?, priority? }
 * -> { job: JobDetail }. Stale version or a move the status rules refuse -> 409 { error, current? }.
 */
export async function PATCH(request: Request, ctx: Ctx) {
  try {
    requireSameOrigin(request);
    const user = await requireRole("dispatcher");
    return Response.json({ job: await updateJob(user, (await ctx.params).id, await readJson(request)) });
  } catch (err) {
    return errorResponse(err);
  }
}
