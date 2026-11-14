import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { BadRequestError } from "@/lib/errors";
import { errorResponse, readJson } from "@/lib/http";
import { jsonHasNul } from "@/lib/text";
import { applySync } from "@/lib/tech-sync";

export const dynamic = "force-dynamic";
export const maxDuration = 25;

const SYNC_BODY_LIMIT = 64 * 1024;

/** POST /api/sync — one batch of technician ops, in order. Technician only. */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireRole("technician");
    const raw = await readJson(request, SYNC_BODY_LIMIT);
    if (jsonHasNul(raw)) throw new BadRequestError("Text can't contain null characters");
    return Response.json(await applySync(user, raw));
  } catch (err) {
    return errorResponse(err);
  }
}
