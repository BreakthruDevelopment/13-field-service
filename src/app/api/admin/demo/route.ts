import { loadDemo } from "@/lib/admin";
import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { JSON_BODY_LIMIT, errorResponse, parseJsonBody, readBodyCapped } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 25;

/**
 * POST /api/admin/demo (admin) body { clientOpId? } (an empty body is fine) -> { demo: { dispatchers, technicians, customers, sites, parts, jobs, replayed } }.
 * Send one `clientOpId` per click: a retry with the same id returns the first result (`replayed: true`) and reloads nothing.
 * 3 loads per admin per hour, 20 app-wide per day.
 */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireRole("admin");
    const bytes = await readBodyCapped(request, JSON_BODY_LIMIT);
    return Response.json({ demo: await loadDemo(user, bytes.length ? parseJsonBody(bytes) : {}) });
  } catch (err) {
    return errorResponse(err);
  }
}
