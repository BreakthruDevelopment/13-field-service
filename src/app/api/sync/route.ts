import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson, withRetryAfter } from "@/lib/http";
import { SYNC_BODY_LIMIT, syncBatch } from "@/lib/sync";

export const dynamic = "force-dynamic";
// The batch stops starting ops after 8 s; the rest of the allowance is for the last op and the response.
export const maxDuration = 25;

/**
 * POST /api/sync (technician). Body (at most 64 KB, 50 ops):
 *   { ownerId, deviceId?, ops: [
 *       { kind: "note.add", opId, jobId, clientAt, body }
 *     | { kind: "status.set", opId, jobId, clientAt, to, baseStatusVersion, dependsOn?, location? } ] }
 * -> 200 { results: [{ opId, outcome: applied | replayed | conflict | rejected | deferred, code?, replayed?, job?, noteId? }], serverTime }
 * One result per op, in order; a refused op never fails the batch. 400 malformed (or NUL), 401/403 role, 409
 * `owner_mismatch` (this device's data belongs to another account; nothing processed), 413 too large, 429 over the limit.
 */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireRole("technician");
    return Response.json(await syncBatch(user, await readJson(request, SYNC_BODY_LIMIT)), { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return withRetryAfter(errorResponse(err));
  }
}
