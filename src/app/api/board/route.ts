import { requireRole } from "@/lib/auth/session";
import { getBoard } from "@/lib/board";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 25;

const query = (request: Request) => Object.fromEntries(new URL(request.url).searchParams);

/**
 * GET /api/board?date=YYYY-MM-DD&tz=America/Chicago (dispatcher; tz defaults to UTC)
 * -> { date, tz, technicians: {id,name}[], jobs: JobSummary[], unassigned: JobSummary[], truncated, serverTime }
 */
export async function GET(request: Request) {
  try {
    const user = await requireRole("dispatcher");
    return Response.json(await getBoard(user, query(request)));
  } catch (err) {
    return errorResponse(err);
  }
}
