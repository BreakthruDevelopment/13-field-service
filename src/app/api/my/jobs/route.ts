import { requireRole } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http";
import { loadSnapshot } from "@/lib/tech-sync";

export const dynamic = "force-dynamic";
export const maxDuration = 25;

/** GET /api/my/jobs — the signed-in technician's snapshot. No other role, and no other person's jobs. */
export async function GET(request: Request) {
  try {
    const user = await requireRole("technician");
    const { body, etag } = await loadSnapshot(user);
    if (request.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag } });
    }
    return Response.json(body, { headers: { ETag: etag } });
  } catch (err) {
    return errorResponse(err);
  }
}
