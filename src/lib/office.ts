import { type Actor } from "@/lib/auth/rbac";
import { NotFoundError } from "@/lib/errors";

/** Anyone but a dispatcher gets the same 404 a missing row would, so the role can't be probed. */
export function assertDispatcher(actor: Actor): void {
  if (actor.role !== "dispatcher") throw new NotFoundError();
}

export const DISPATCH_WRITE_LIMIT = 300;

export const DISPATCH_WRITE_MESSAGE = "Too many changes this hour. Try again later.";
