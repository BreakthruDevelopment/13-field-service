import { setUserRole } from "@/lib/admin";
import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 25;

/**
 * POST /api/admin/roles (admin) body { userId, role: "user" | "technician" | "dispatcher" } -> { user, unassignedJobs }
 * The only way a role changes. Admin accounts can't be changed (409). Revoking technician unassigns their open jobs.
 */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireRole("admin");
    return Response.json(await setUserRole(user, await readJson(request)));
  } catch (err) {
    return errorResponse(err);
  }
}
