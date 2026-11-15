import "server-only";
import { eq } from "drizzle-orm";
import { type Actor, ForbiddenError, toRole } from "@/lib/auth/rbac";
import { schema } from "@/lib/db";
import type { Tx } from "@/lib/usage";

/**
 * Re-read the acting user `for share` (the same first lock `updateJob` takes) and refuse when their role changed or they
 * were banned since the session was issued. Waits for a concurrent role change, so the check can't race it. Lock order:
 * this first, then the job row, then cap locks (`src/lib/caps.ts`).
 */
export async function assertActorCurrent(tx: Tx, actor: Actor): Promise<void> {
  const { user } = schema;
  const [row] = await tx.select({ role: user.role, banned: user.banned }).from(user).where(eq(user.id, actor.id)).for("share");
  if (!row || row.banned || toRole(row.role) !== actor.role) throw new ForbiddenError();
}
