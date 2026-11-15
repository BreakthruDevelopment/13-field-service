import "server-only";
import { and, count, desc, eq, gte, ilike, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { assertCan } from "@/lib/access";
import { type Actor, GRANTABLE_ROLES, type Role, ROLES, toRole } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { env } from "@/lib/env";
import { type DemoSummary, loadDemoWorkspace } from "@/lib/demo";
import { ConflictError, NotFoundError, TooManyRequestsError, VersionConflictError } from "@/lib/errors";
import { ACTIVE_STATUSES } from "@/lib/job-status";
import { log } from "@/lib/log";
import { idText, text } from "@/lib/text";
import { consumeRate, dailyCount, reserveDaily } from "@/lib/usage";
import { spendRead, writeTx } from "@/lib/write-tx";

/**
 * Admin: counts, the user directory and role grants. Nothing here reads a job, customer, note or location.
 * `setUserRole` is the only way a role changes (Better Auth's /admin/set-role is disabled); it is audited as `role.changed`.
 */

export type AdminStats = {
  jobsByStatus: Record<(typeof schema.SERVICE_JOB_STATUSES)[number], number>;
  usersByRole: Record<Role, number>;
  /** `sync_op` outcomes over the last 7 days. */
  syncOutcomes: { applied: number; conflict: number; rejected: number; pending: number };
  /** AI drafts today (UTC) against the app-wide daily cap. */
  ai: { today: number; cap: number };
  generatedAt: string;
};

export async function getAdminStats(actor: Actor): Promise<AdminStats> {
  assertCan(actor, "read", "stats");
  await spendRead(actor);
  const { serviceJob, user, syncOp } = schema;
  const jobRows = await db().select({ status: serviceJob.status, n: count() }).from(serviceJob).groupBy(serviceJob.status);
  const userRows = await db().select({ role: user.role, n: count() }).from(user).groupBy(user.role);
  const syncRows = await db()
    .select({ outcome: syncOp.outcome, n: count() })
    .from(syncOp)
    .where(gte(syncOp.receivedAt, sql`now() - interval '7 days'`))
    .groupBy(syncOp.outcome);

  const jobsByStatus = Object.fromEntries(schema.SERVICE_JOB_STATUSES.map((s) => [s, 0])) as AdminStats["jobsByStatus"];
  for (const r of jobRows) jobsByStatus[r.status] = r.n;
  const usersByRole = Object.fromEntries(ROLES.map((r) => [r, 0])) as AdminStats["usersByRole"];
  for (const r of userRows) usersByRole[toRole(r.role)] += r.n;
  const syncOutcomes = { applied: 0, conflict: 0, rejected: 0, pending: 0 };
  for (const r of syncRows) syncOutcomes[r.outcome ?? "pending"] = r.n;
  return { jobsByStatus, usersByRole, syncOutcomes, ai: { today: await dailyCount("ai"), cap: env().AI_DAILY_CAP }, generatedAt: new Date().toISOString() };
}

export type DirectoryUser = { id: string; name: string; email: string; role: Role; createdAt: string };

export const userListQuery = z.strictObject({
  q: text(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Name, email and role of accounts, for the admin's role screen. No sessions, tokens or activity. */
export async function listUsers(actor: Actor, input: unknown): Promise<{ users: DirectoryUser[] }> {
  assertCan(actor, "read", "user_directory");
  await spendRead(actor);
  const f = userListQuery.parse(input ?? {});
  const like = f.q ? `%${escapeLike(f.q)}%` : undefined;
  const rows = await db()
    .select({ id: schema.user.id, name: schema.user.name, email: schema.user.email, role: schema.user.role, createdAt: schema.user.createdAt })
    .from(schema.user)
    .where(like ? or(ilike(schema.user.name, like), ilike(schema.user.email, like)) : undefined)
    .orderBy(desc(schema.user.createdAt))
    .limit(f.limit);
  return { users: rows.map((r) => ({ ...r, role: toRole(r.role), createdAt: r.createdAt.toISOString() })) };
}

export const setRoleInput = z.strictObject({
  userId: idText,
  /** The role to set. */
  role: z.enum(GRANTABLE_ROLES),
  /** The role the admin saw when they decided. Applied only if the user still has it; otherwise 409 with the current role. */
  from: z.enum(ROLES),
  /** One id per click (`opFor`): an exact retry returns the first result, even after someone else changed the role since. */
  clientOpId: z.string().uuid().optional(),
});

export type RoleChangeResult = { user: DirectoryUser; unassignedJobs: number };

/**
 * Grant or revoke `technician` / `dispatcher` (or reset to `user`). Admin accounts can't be changed here. Revoking
 * `technician` unassigns that person's open jobs in the same transaction (they go back to the unassigned tray) so no
 * job is stranded with someone who can no longer see it.
 */
export async function setUserRole(actor: Actor, input: unknown): Promise<RoleChangeResult & { replayed: boolean }> {
  assertCan(actor, "update", "role");
  const data = setRoleInput.parse(input);
  const out = await writeTx(actor, async (tx) => {
    const { user, serviceJob, jobEvent, roleChangeOp } = schema;
    if (data.clientOpId) {
      // The unique key makes a parallel duplicate wait for the first transaction, then see its stored result.
      const [mine] = await tx.insert(roleChangeOp).values({ adminId: actor.id, clientOpId: data.clientOpId }).onConflictDoNothing().returning({ id: roleChangeOp.clientOpId });
      if (!mine) {
        const [first] = await tx.select().from(roleChangeOp).where(and(eq(roleChangeOp.adminId, actor.id), eq(roleChangeOp.clientOpId, data.clientOpId)));
        if (first?.result) return { replayed: true as const, result: first.result as unknown as RoleChangeResult };
        throw new ConflictError("That role change is still running. Try again.");
      }
    }
    const [target] = await tx.select().from(user).where(eq(user.id, data.userId)).for("update");
    if (!target) throw new NotFoundError("User not found");
    const from = toRole(target.role);
    if (from === "admin") throw new ConflictError("Admin accounts can't be changed here.");
    // Compare-and-set: a retry after someone else changed the role must not silently undo their change.
    if (from !== data.from) throw new VersionConflictError({ userId: target.id, role: from });
    await tx.update(user).set({ role: data.role, updatedAt: new Date() }).where(eq(user.id, target.id));

    let unassigned = 0;
    if (from === "technician" && data.role !== "technician") {
      const open = await tx
        .select({ id: serviceJob.id, status: serviceJob.status })
        .from(serviceJob)
        .where(and(eq(serviceJob.assigneeId, target.id), inArray(serviceJob.status, [...ACTIVE_STATUSES])))
        .for("update");
      for (const job of open) {
        await tx
          .update(serviceJob)
          .set({
            assigneeId: null,
            status: "unassigned",
            statusVersion: sql`${serviceJob.statusVersion} + 1`,
            version: sql`${serviceJob.version} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(serviceJob.id, job.id));
        await tx.insert(jobEvent).values({ jobId: job.id, actorId: actor.id, kind: "unassigned", fromStatus: job.status, toStatus: "unassigned" });
      }
      unassigned = open.length;
    }
    const result: RoleChangeResult = {
      user: { id: target.id, name: target.name, email: target.email, role: data.role, createdAt: target.createdAt.toISOString() },
      unassignedJobs: unassigned,
    };
    if (data.clientOpId) await tx.update(roleChangeOp).set({ result }).where(and(eq(roleChangeOp.adminId, actor.id), eq(roleChangeOp.clientOpId, data.clientOpId)));
    return { replayed: false as const, result };
  });
  if (!out.replayed) log.info("role.changed", { actorId: actor.id, userId: out.result.user.id, from: data.from, to: data.role, unassignedJobs: out.result.unassignedJobs });
  return { ...out.result, replayed: out.replayed };
}

/** The demo button's caps: 3 loads per admin per hour, 20 app-wide per UTC day. */
export const DEMO_LOADS_PER_HOUR = 3;
export const DEMO_LOADS_PER_DAY = 20;

export const demoLoadInput = z.strictObject({
  /** One id per click (`opFor`): a retry after a lost response returns the first result and reloads nothing. */
  clientOpId: z.string().uuid().optional(),
});

/** POST /api/admin/demo: (re)load the demo workspace. Demo users get no password. See `src/lib/demo.ts`. */
export async function loadDemo(actor: Actor, input: unknown = {}): Promise<DemoSummary & { replayed: boolean }> {
  assertCan(actor, "create", "demo");
  const { clientOpId } = demoLoadInput.parse(input);
  const out = await writeTx(actor, async (tx) => {
    const { demoLoadOp } = schema;
    if (clientOpId) {
      // The unique key makes a parallel duplicate wait for the first transaction, then see its stored result.
      const [mine] = await tx.insert(demoLoadOp).values({ adminId: actor.id, clientOpId }).onConflictDoNothing().returning({ clientOpId: demoLoadOp.clientOpId });
      if (!mine) {
        const [first] = await tx.select().from(demoLoadOp).where(and(eq(demoLoadOp.adminId, actor.id), eq(demoLoadOp.clientOpId, clientOpId)));
        if (first?.result) return { summary: first.result as unknown as DemoSummary, replayed: true };
        throw new ConflictError("That demo load is still running. Try again.");
      }
    }
    await consumeRate(tx, actor.id, "demo_load", DEMO_LOADS_PER_HOUR, "The demo was loaded a few times already. Try again later.");
    if (!(await reserveDaily(tx, "demo_load", DEMO_LOADS_PER_DAY))) throw new TooManyRequestsError("The demo has been loaded too many times today.");
    const summary = await loadDemoWorkspace(tx);
    if (clientOpId) await tx.update(demoLoadOp).set({ result: summary }).where(and(eq(demoLoadOp.adminId, actor.id), eq(demoLoadOp.clientOpId, clientOpId)));
    return { summary, replayed: false };
  });
  if (!out.replayed) log.info("demo.loaded", { actorId: actor.id, ...out.summary });
  return { ...out.summary, replayed: out.replayed };
}
