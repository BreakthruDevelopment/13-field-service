/**
 * Better Auth admin-plugin permissions.
 *
 * Our apps promise that admins see counts, never other users' private data.
 * Better Auth's default `admin` role includes `impersonate` and `set-password`
 * (and the statement list has `impersonate-admins` and `set-email`), which would
 * let an admin become any user or reset their password. This role leaves those out.
 *
 * Deliberately NOT granted to admins: user `set-role`, `create`, `update`, `delete` (see below), user `impersonate`, `impersonate-admins`,
 * `set-password`, `set-email`, and session `list` (it returns other users' raw session
 * tokens, IP addresses and user agents). Do not add them back.
 */
import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/admin/access";

export const ac = createAccessControl(defaultStatements);

/**
 * Admins keep only list, get and ban here. Role changes go through `POST /api/admin/roles` (audited), and Better Auth's
 * own set-role, create-user, update-user and remove-user are not granted and are also in `DISABLED_AUTH_PATHS`.
 * `technician` and `dispatcher` are app roles; they carry no Better Auth admin-plugin permissions (as app 8's
 * `underwriter` and app 11's `agent`): the app's own access rules are in `src/lib/access.ts`.
 */
export const roles = {
  admin: ac.newRole({
    user: ["list", "ban", "get"],
    session: ["revoke", "delete"],
  }),
  dispatcher: ac.newRole({ user: [], session: [] }),
  technician: ac.newRole({ user: [], session: [] }),
  user: ac.newRole({ user: [], session: [] }),
};

/** Blocked at the HTTP layer as well, in case a role is ever widened by mistake. */
export const DISABLED_AUTH_PATHS = [
  "/admin/impersonate-user",
  "/admin/stop-impersonating",
  "/admin/set-user-password",
  "/admin/list-user-sessions",
  // Roles change only through POST /api/admin/roles; nothing creates, edits or deletes users from the admin side.
  // Account deletion is out of scope: user foreign keys in the domain tables are `restrict`.
  "/admin/set-role",
  "/admin/create-user",
  "/admin/update-user",
  "/admin/remove-user",
];
