/**
 * Role-based access control, kept as plain functions so it is easy to unit test
 * and impossible to bypass from the client: every server action and route
 * handler calls these before touching data.
 */

/** `user` is waiting for access. `technician` and `dispatcher` are granted by an admin. Exactly one role. */
export const ROLES = ["user", "technician", "dispatcher", "admin"] as const;
export type Role = (typeof ROLES)[number];

export type Actor = { id: string; role: Role };

export type Action = "read" | "create" | "update" | "delete";

/** A resource the actor may or may not own. */
export type Owned = { ownerId: string };

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/**
 * Better Auth's admin plugin can store comma-separated roles. Return exactly one, the strongest
 * (admin, then dispatcher, then technician, then user). Unknown names are `user`.
 * Admin is not a superset of dispatcher or technician.
 */
export function toRole(value: string | null | undefined): Role {
  if (!value) return "user";
  const parts = value.split(",").map((p) => p.trim());
  if (parts.includes("admin")) return "admin";
  if (parts.includes("dispatcher")) return "dispatcher";
  if (parts.includes("technician")) return "technician";
  return "user";
}

export function can(actor: Actor, action: Action, resource?: Owned): boolean {
  if (actor.role === "admin") return true;
  if (action === "create") return true;
  if (!resource) return false;
  return resource.ownerId === actor.id;
}

export class ForbiddenError extends Error {
  readonly status = 403;
  constructor(message = "You don't have permission to do that.") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class UnauthorizedError extends Error {
  readonly status = 401;
  constructor(message = "Sign in to continue.") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export function assertCan(actor: Actor, action: Action, resource?: Owned): void {
  if (!can(actor, action, resource)) throw new ForbiddenError();
}
