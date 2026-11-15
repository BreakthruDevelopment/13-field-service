import { setUserRole } from "@/lib/admin";
import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 25;

/**
 * POST /api/admin/roles (admin) body { userId, role: "user" | "technician" | "dispatcher", from: <the role the admin saw>, clientOpId? }
 * -> { user, unassignedJobs, replayed }. Applied only if the user's role still equals `from`; otherwise 409 { error, current: { userId, role } }.
 * An exact retry with the same clientOpId returns the first result (replayed: true) and changes nothing.
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
