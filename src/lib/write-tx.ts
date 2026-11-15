import "server-only";
import { db } from "@/lib/db";
import { consumeRate, type Tx } from "@/lib/usage";
import type { Actor } from "@/lib/auth/rbac";

/** Dispatcher (and admin) writes per user per hour: the `api_write` kind in the spec's rate table. */
export const WRITE_LIMIT_PER_HOUR = 300;

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
