import { requireRole } from "@/lib/auth/session";
import { listTechnicians } from "@/lib/board";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 25;

/** GET /api/technicians (dispatcher) -> { technicians: { id, name }[] } active technicians, for the assignee picker. */
export async function GET() {
  try {
    const user = await requireRole("dispatcher");
    return Response.json(await listTechnicians(user));
  } catch (err) {
    return errorResponse(err);
  }
}
