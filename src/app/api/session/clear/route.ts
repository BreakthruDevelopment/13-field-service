import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse } from "@/lib/http";
import { requireUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const CLEAR = { "Clear-Site-Data": '"cache", "storage"' };

/**
 * POST /api/session/clear — asks the browser to drop cache and storage after sign-out.
 * Same-origin only. The header is set even when the session is already gone, so it still
 * works as a backstop if sign-out ran first.
 */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    try {
      await requireUser();
    } catch {
      return new Response(null, { status: 401, headers: CLEAR });
    }
    return new Response(null, { status: 204, headers: CLEAR });
  } catch (err) {
    return errorResponse(err);
  }
}
