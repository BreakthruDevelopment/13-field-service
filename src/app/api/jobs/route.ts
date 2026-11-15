import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { createJob, listJobs } from "@/lib/service-jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 25;

const query = (request: Request) => Object.fromEntries(new URL(request.url).searchParams);

/**
 * GET /api/jobs?status=&assigneeId=&customerId=&q=&from=&to=&limit=&offset= (dispatcher: all jobs; technician: only their own)
 * -> { jobs: JobSummary[], hasMore }
 */
export async function GET(request: Request) {
  try {
    const user = await requireRole("dispatcher", "technician");
    return Response.json(await listJobs(user, query(request)));
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/jobs (dispatcher) body { customerId, siteId, title, description?, priority?, assigneeId?, scheduledStart?, scheduledEnd?, clientOpId? }
 * -> 201 { job: JobDetail } (200 on a replayed clientOpId). With assigneeId the job is `scheduled` (a window is required), else `unassigned`.
 */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireRole("dispatcher");
    const { job, created } = await createJob(user, await readJson(request));
    return Response.json({ job }, { status: created ? 201 : 200 });
  } catch (err) {
    return errorResponse(err);
  }
}
