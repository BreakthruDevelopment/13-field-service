import "server-only";
import { db } from "@/lib/db";
import { consumeRate, type Tx } from "@/lib/usage";
import type { Actor } from "@/lib/auth/rbac";

/** Dispatcher (and admin) writes per user per hour: the `api_write` kind in the spec's rate table. */
export const WRITE_LIMIT_PER_HOUR = 300;

/** Signed-in reads per user per hour: the `read` kind. Generous for a polling board, but not unbounded. */
export const READ_LIMIT_PER_HOUR = 600;

/** Spend one `read` attempt for the actor (429 when over the limit), in its own short transaction. Call after `assertCan`. */
export async function spendRead(actor: Actor): Promise<void> {
  await db().transaction((tx) => consumeRate(tx, actor.id, "read", READ_LIMIT_PER_HOUR, "Too many requests. Try again later."));
}

/**
 * Run a mutation in one short transaction that first spends one `api_write` attempt for the actor (429 when over the
 * limit). A failed mutation rolls the attempt back with everything else, so a refused request costs nothing.
 */
export function writeTx<T>(actor: Actor, work: (tx: Tx) => Promise<T>): Promise<T> {
  return db().transaction(async (tx) => {
    await consumeRate(tx, actor.id, "api_write", WRITE_LIMIT_PER_HOUR, "Too many changes. Try again later.");
    return work(tx);
  });
}
