import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { BadRequestError } from "@/lib/errors";
import { errorResponse, readJson } from "@/lib/http";
import { jsonHasNul } from "@/lib/text";
import { getWorkOrder, saveWorkOrder } from "@/lib/work-order";

export const dynamic = "force-dynamic";
export const maxDuration = 25;

/** GET /api/jobs/:id/work-order — the technician's draft for one assigned job. */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireRole("technician");
    const { id } = await ctx.params;
    return Response.json({ workOrder: await getWorkOrder(user, id) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** PATCH /api/jobs/:id/work-order — edit or submit. Offline edits are not accepted here; the phone disables them. */
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const user = await requireRole("technician");
    const raw = await readJson(request);
    if (jsonHasNul(raw)) throw new BadRequestError("Text can't contain null characters");
    const { id } = await ctx.params;
    return Response.json({ workOrder: await saveWorkOrder(user, id, raw) });
  } catch (err) {
    return errorResponse(err);
  }
}
