import { clientIp, allowPublicRequest } from "@/lib/ip-limit";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * POST /api/session/clear: the backstop of `signOutAndWipe()`. Answers `Clear-Site-Data: "cache", "storage"`, so a browser
 * that honours it drops Cache Storage, IndexedDB, localStorage and service workers for this origin even if the client-side
 * wipe was interrupted. It is called after sign-out, so it needs no session (and reveals nothing): our own Origin and the
 * per-IP public limit keep other sites and loops away. It deliberately leaves cookies alone; Better Auth clears its own.
 */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    if (!allowPublicRequest(clientIp(request))) return Response.json({ error: "Too many requests" }, { status: 429, headers: { "retry-after": "60" } });
    return new Response(null, { status: 204, headers: { "clear-site-data": '"cache", "storage"', "cache-control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
