/**
 * Every "count, then add" cap in the app, and the advisory lock that serializes it. No `server-only` and no `@/` imports,
 * because the demo loader (also run by `scripts/seed-demo.mts`) uses it.
 *
 * Rule: anything that can raise a capped count (create, reopen, the demo loader) takes the cap's lock with
 * `pg_advisory_xact_lock`, then counts, then writes, all in one transaction. Lock order: user row, job row, cap lock
 * (a cap lock is taken last among row locks, so no cycle can form).
 */
export const CAP_LOCKS = {
  openJobs: "cap:open_jobs",
  parts: "cap:parts",
  demoLoad: "cap:demo_load",
} as const;

/** Open (not completed or cancelled) jobs, app-wide. */
export const MAX_OPEN_JOBS = 2000;
/** Rows in the part catalog, active or not. */
export const MAX_PARTS = 500;

/** The live caps. A mutable holder only so tests can lower them for their own process; production never changes it. */
export const capLimits = { openJobs: MAX_OPEN_JOBS, parts: MAX_PARTS };
