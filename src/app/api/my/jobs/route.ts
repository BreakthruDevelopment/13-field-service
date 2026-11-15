import { requireRole } from "@/lib/auth/session";
import { errorResponse, withRetryAfter } from "@/lib/http";
import { getTechSnapshot } from "@/lib/tech-snapshot";

export const dynamic = "force-dynamic";
export const maxDuration = 25;

/**
 * GET /api/my/jobs (technician): the offline snapshot, `{ userId, serverTime, jobs, truncated }` (see `tech-snapshot.ts`).
 * Sends a weak `ETag`; a matching `If-None-Match` gets 304 with no body. `no-store` keeps shared caches and the service
 * worker away from it: the client keeps its own copy in IndexedDB. Over the limit: 429 with `Retry-After`.
 */
export async function GET(request: Request) {
  try {
    const user = await requireRole("technician");
    const { snapshot, etag } = await getTechSnapshot(user);
    const headers = { "cache-control": "no-store", vary: "Cookie", etag };
    if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
    return Response.json(snapshot, { headers });
  } catch (err) {
    return withRetryAfter(errorResponse(err));
  }
}
