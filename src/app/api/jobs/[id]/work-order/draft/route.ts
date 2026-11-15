import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { generateWorkOrder } from "@/lib/work-orders";

export const dynamic = "force-dynamic";
// The model call is bounded by AI_TIMEOUT_MS (20 s); Lambda's limit is 29 s.
export const maxDuration = 25;

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/jobs/:id/work-order/draft { clientOpId, baseVersion } (technician: own job; dispatcher: any). Online only.
 * `baseVersion` is the `version` of the work order the client shows, or null when there is none. Mint one `clientOpId` per click and
 * keep it until the server answers (`opFor`): a retry returns the first draft and is not charged again.
 * -> { workOrder, replayed }. 404 someone else's job; 409 stale baseVersion { error, current }, or { error, code } with code
 * no_notes | work_order_locked | job_cancelled | in_progress | op_id_reused; 429 over the AI limits; 502 the model failed (nothing charged).
 */
export async function POST(request: Request, ctx: Ctx) {
  try {
    requireSameOrigin(request);
    const user = await requireRole("dispatcher", "technician");
    return Response.json(await generateWorkOrder(user, (await ctx.params).id, await readJson(request, 4 * 1024)));
  } catch (err) {
    return errorResponse(err);
  }
}
