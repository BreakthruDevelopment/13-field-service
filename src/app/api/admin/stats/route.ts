import { getAdminStats } from "@/lib/admin";
import { requireRole } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 25;

/** GET /api/admin/stats (admin) -> AdminStats: { jobsByStatus, usersByRole, syncOutcomes, ai: { today, cap }, generatedAt }. Counts only. */
export async function GET() {
  try {
    const user = await requireRole("admin");
    return Response.json(await getAdminStats(user));
  } catch (err) {
    return errorResponse(err);
  }
}
