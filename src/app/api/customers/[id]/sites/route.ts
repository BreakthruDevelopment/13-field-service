import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { createSite } from "@/lib/customers";

export const dynamic = "force-dynamic";
export const maxDuration = 25;

/** POST /api/customers/:id/sites (dispatcher) body { label, address, accessNotes?, lat?, lng?, clientOpId? } -> 201 { site } */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const user = await requireRole("dispatcher");
    const { site, created } = await createSite(user, (await ctx.params).id, await readJson(request));
    return Response.json({ site }, { status: created ? 201 : 200 });
  } catch (err) {
    return errorResponse(err);
  }
}
