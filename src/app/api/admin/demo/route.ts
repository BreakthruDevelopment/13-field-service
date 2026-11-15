import { loadDemo } from "@/lib/admin";
import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 25;

/** POST /api/admin/demo (admin) no body -> { demo: { dispatchers, technicians, customers, sites, parts, jobs } }. 3 per admin per hour, 20 app-wide per day. */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireRole("admin");
    return Response.json({ demo: await loadDemo(user) });
  } catch (err) {
    return errorResponse(err);
  }
}
