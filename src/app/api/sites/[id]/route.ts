import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { updateSite } from "@/lib/customers";

export const dynamic = "force-dynamic";
export const maxDuration = 25;

/** PATCH /api/sites/:id (dispatcher) body { version, label?, address?, accessNotes?, lat?, lng? } -> { site }; stale version -> 409 { error, current } */
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const user = await requireRole("dispatcher");
    return Response.json({ site: await updateSite(user, (await ctx.params).id, await readJson(request)) });
  } catch (err) {
    return errorResponse(err);
  }
}
