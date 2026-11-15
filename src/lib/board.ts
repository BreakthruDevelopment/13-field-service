import "server-only";
import { and, eq, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { assertCan } from "@/lib/access";
import { type Actor, toRole } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { BadRequestError } from "@/lib/errors";
import { spendRead } from "@/lib/write-tx";
import { runMaintenance } from "@/lib/maintenance";
import { BOARD_LIMIT, type JobSummary, selectSummaries } from "@/lib/service-jobs";

/**
 * The schedule board: one day, a lane per technician, plus the unassigned tray. Dispatchers only.
 * `date` is a calendar day (`YYYY-MM-DD`) in the shop's time zone `tz` (an IANA name, default UTC).
 */

export const boardQuery = z.strictObject({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  tz: z.string().max(64).default("UTC"),
});

export type Board = {
  date: string;
  tz: string;
  technicians: { id: string; name: string }[];
  /** Assigned jobs scheduled on `date`, cancelled ones left out. Group by `assignee.id` for the lanes. */
  jobs: JobSummary[];
  /** Every unassigned job, whatever its date: the tray. */
  unassigned: JobSummary[];
  /** More than 200 jobs matched; the board shows the first 200 by start time. */
  truncated: boolean;
  serverTime: string;
};

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return /^[A-Za-z0-9_+\-/]+$/.test(tz);
  } catch {
    return false;
  }
}

/** Postgres decides which zone names it can use (Intl knows some it doesn't), so ask it. */
async function knownTimeZone(tz: string): Promise<boolean> {
  const rows = await db().execute(sql`select 1 from pg_timezone_names where name = ${tz} limit 1`);
  return rows.length > 0;
}

export type TechnicianDto = { id: string; name: string };

async function activeTechnicians(): Promise<TechnicianDto[]> {
  const techs = await db()
    .select({ id: schema.user.id, name: schema.user.name, role: schema.user.role })
    .from(schema.user)
    .where(and(eq(schema.user.role, "technician"), sql`coalesce(${schema.user.banned}, false) = false`));
  return techs.filter((t) => toRole(t.role) === "technician").map((t) => ({ id: t.id, name: t.name })).sort((a, b) => a.name.localeCompare(b.name));
}

/** GET /api/technicians: active technicians (id and name), for the assignee picker. Dispatchers only. */
export async function listTechnicians(actor: Actor): Promise<{ technicians: TechnicianDto[] }> {
  assertCan(actor, "read", "board");
  await spendRead(actor);
  return { technicians: await activeTechnicians() };
}

export async function getBoard(actor: Actor, input: unknown): Promise<Board> {
  assertCan(actor, "read", "board");
  await spendRead(actor);
  const q = boardQuery.parse(input ?? {});
  if (!validTimeZone(q.tz) || !(await knownTimeZone(q.tz)) || Number.isNaN(Date.parse(`${q.date}T00:00:00Z`)) || new Date(`${q.date}T00:00:00Z`).toISOString().slice(0, 10) !== q.date) {
    throw new BadRequestError("Invalid date or time zone");
  }
  await runMaintenance(); // lazy purge of old check-in locations and the sync ledger (never throws)

  const dayStart = sql`(${q.date}::date)::timestamp at time zone ${q.tz}`;
  const dayEnd = sql`((${q.date}::date + 1))::timestamp at time zone ${q.tz}`;
  const { serviceJob } = schema;
  const rows = await selectSummaries(
    db(),
    or(
      and(sql`${serviceJob.scheduledStart} >= ${dayStart}`, sql`${serviceJob.scheduledStart} < ${dayEnd}`, ne(serviceJob.status, "cancelled"), ne(serviceJob.status, "unassigned")),
      eq(serviceJob.status, "unassigned"),
    ),
    { limit: BOARD_LIMIT + 1 },
  );
  const truncated = rows.length > BOARD_LIMIT;
  const kept = rows.slice(0, BOARD_LIMIT);
  return {
    date: q.date,
    tz: q.tz,
    technicians: await activeTechnicians(),
    jobs: kept.filter((j) => j.status !== "unassigned"),
    unassigned: kept.filter((j) => j.status === "unassigned"),
    truncated,
    serverTime: new Date().toISOString(),
  };
}
