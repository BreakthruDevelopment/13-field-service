import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { getWorkOrder, updateWorkOrder } from "@/lib/work-orders";

export const dynamic = "force-dynamic";
export const maxDuration = 25;

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/jobs/:id/work-order (technician: own job; dispatcher: any) -> { workOrder: WorkOrder | null }. Someone else's or a missing job -> 404. */
export async function GET(_request: Request, ctx: Ctx) {
  try {
    const user = await requireRole("dispatcher", "technician");
    return Response.json({ workOrder: await getWorkOrder(user, (await ctx.params).id) });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * PATCH /api/jobs/:id/work-order. One op per request, each with the `version` last seen and a `clientOpId` (a retry with the
 * same id returns the first result, `replayed: true`):
 *   { op: "edit", clientOpId, version, summary?, tasks?, followUp?, lines? }  technician (own, draft or returned) / dispatcher (not approved)
 *   | { op: "submit", clientOpId, version }                                    technician (own)
 *   | { op: "approve", clientOpId, version }                                   dispatcher (submitted)
 *   | { op: "return", clientOpId, version, reason }                            dispatcher (submitted)
 * -> { workOrder, replayed }. Stale version -> 409 { error, current }. A refused state -> 409 { error, code }.
 */
export async function PATCH(request: Request, ctx: Ctx) {
  try {
    requireSameOrigin(request);
    const user = await requireRole("dispatcher", "technician");
    return Response.json(await updateWorkOrder(user, (await ctx.params).id, await readJson(request, 32 * 1024)));
  } catch (err) {
    return errorResponse(err);
  }
}
