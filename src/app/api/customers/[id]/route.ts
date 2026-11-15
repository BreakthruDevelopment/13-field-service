import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { getCustomer, updateCustomer } from "@/lib/customers";

export const dynamic = "force-dynamic";
export const maxDuration = 25;

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/customers/:id (dispatcher) -> { customer, sites, jobs } */
export async function GET(_request: Request, ctx: Ctx) {
  try {
    const user = await requireRole("dispatcher");
    return Response.json(await getCustomer(user, (await ctx.params).id));
  } catch (err) {
    return errorResponse(err);
  }
}

/** PATCH /api/customers/:id (dispatcher) body { version, name?, phone?, email?, notes? } -> { customer }; stale version -> 409 { error, current } */
export async function PATCH(request: Request, ctx: Ctx) {
  try {
    requireSameOrigin(request);
    const user = await requireRole("dispatcher");
    return Response.json({ customer: await updateCustomer(user, (await ctx.params).id, await readJson(request)) });
  } catch (err) {
    return errorResponse(err);
  }
}
