import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { createPart, listParts } from "@/lib/parts";

export const dynamic = "force-dynamic";
export const maxDuration = 25;

const query = (request: Request) => Object.fromEntries(new URL(request.url).searchParams);

/** GET /api/parts?q=&includeInactive=&limit=&offset= (technician and dispatcher; only dispatchers may includeInactive) -> { parts: Part[], hasMore } */
export async function GET(request: Request) {
  try {
    const user = await requireRole("dispatcher", "technician");
    return Response.json(await listParts(user, query(request)));
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/parts (dispatcher) body { sku, name, unit?, aliases?, maxPerJob?, active?, clientOpId? } -> 201 { part }; a taken SKU -> 409 */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireRole("dispatcher");
    const { part, created } = await createPart(user, await readJson(request));
    return Response.json({ part }, { status: created ? 201 : 200 });
  } catch (err) {
    return errorResponse(err);
  }
}
