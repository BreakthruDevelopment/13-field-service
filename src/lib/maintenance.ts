import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { LOCATION_RETENTION_DAYS } from "@/lib/location";
import { log } from "@/lib/log";

/** `sync_op` rows (the replay ledger, 13.2) are kept this long. */
export const SYNC_OP_RETENTION_DAYS = 30;

/**
 * Null the check-in coordinates of jobs that closed more than 90 days ago (decision D6): `completed` jobs by
 * `completed_at`, `cancelled` jobs (terminal, so `updated_at` stops moving) by `updated_at`. One indexed, idempotent
 * UPDATE; safe to run on every board load. Returns the number of events cleared.
 */
export async function purgeStaleLocations(): Promise<number> {
  const rows = await db().execute<{ id: string }>(sql`
    update job_event e
       set lat = null, lng = null, accuracy_m = null, captured_at = null
     where e.lat is not null
       and e.job_id in (
         select j.id from service_job j
          where (j.status = 'completed' and j.completed_at < now() - make_interval(days => ${LOCATION_RETENTION_DAYS}))
             or (j.status = 'cancelled' and j.updated_at < now() - make_interval(days => ${LOCATION_RETENTION_DAYS}))
       )
    returning e.id
  `);
  return rows.length;
}

/** Delete replay-ledger rows older than 30 days. */
export async function pruneSyncOps(): Promise<number> {
  const rows = await db().execute<{ op_id: string }>(
    sql`delete from sync_op where received_at < now() - make_interval(days => ${SYNC_OP_RETENTION_DAYS}) returning op_id`,
  );
  return rows.length;
}

/** The lazy hook board loads call. Never throws: housekeeping must not break the page. */
export async function runMaintenance(): Promise<void> {
  try {
    const cleared = await purgeStaleLocations();
    const pruned = await pruneSyncOps();
    if (cleared || pruned) log.info("maintenance.ran", { locationsCleared: cleared, syncOpsPruned: pruned });
  } catch (err) {
    log.warn("maintenance.failed", { error: err instanceof Error ? err.name : "unknown" });
  }
}
