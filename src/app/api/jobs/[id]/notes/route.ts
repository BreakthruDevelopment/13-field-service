import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { addJobNote } from "@/lib/service-jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 25;

/**
 * POST /api/jobs/:id/notes (dispatcher on any job; technician on their own) body { body, opId?, clientAt? }
 * -> 201 { job: JobDetail } (200 on a replayed opId). Offline technician notes go through /api/sync instead.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const user = await requireRole("dispatcher", "technician");
    const { job, created } = await addJobNote(user, (await ctx.params).id, await readJson(request));
    return Response.json({ job }, { status: created ? 201 : 200 });
  } catch (err) {
    return errorResponse(err);
  }
}
