/**
 * Roles and the errors the access layer throws. The access rules themselves live in `src/lib/access.ts`.
 *
 * Four roles, exactly one per user: `admin` > `dispatcher` > `technician` > `user`. The order only decides which role wins
 * when Better Auth hands back a comma-separated list; it is NOT a permission hierarchy. Admin is not a superset of
 * dispatcher or technician (admins see counts and manage roles, never job, customer or location content).
 * A new sign-up is `user` and can do nothing until an admin grants a role (`POST /api/admin/roles`).
 */

export const ROLES = ["user", "technician", "dispatcher", "admin"] as const;
export type Role = (typeof ROLES)[number];

/** Roles an admin may grant. `admin` is never granted through the app. */
export const GRANTABLE_ROLES = ["user", "technician", "dispatcher"] as const;
export type GrantableRole = (typeof GRANTABLE_ROLES)[number];

export type Actor = { id: string; role: Role };

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/** Better Auth's admin plugin can store comma-separated roles; take the strongest known one. */
export function toRole(value: string | null | undefined): Role {
  if (!value) return "user";
  const parts = value.split(",").map((p) => p.trim());
  for (const role of ["admin", "dispatcher", "technician"] as const) {
    if (parts.includes(role)) return role;
  }
  return "user";
}

/** Where each role lands after sign-in. */
export function homeFor(role: Role): string {
  switch (role) {
    case "admin":
      return "/admin";
    case "dispatcher":
      return "/board";
    case "technician":
      return "/tech";
    default:
      return "/waiting";
  }
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
