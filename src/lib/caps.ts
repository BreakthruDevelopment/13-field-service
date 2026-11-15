/**
 * Every "count, then add" cap in the app, and the advisory lock that serializes it. No `server-only` and no `@/` imports,
 * because the demo loader (also run by `scripts/seed-demo.mts`) uses it.
 *
 * Rule: anything that can raise a capped count (create, reopen, the demo loader) takes the cap's lock with
 * `pg_advisory_xact_lock`, then counts, then writes, all in one transaction. Lock order: user row, job row, cap lock
 * (a cap lock is taken last among row locks, so no cycle can form). The AI work-order draft (13.3) follows the same
 * order and adds its own locks after the job row: the per-user `rate:ai:<user>` lock (inside `consumeRate`), then
 * `aiJobLock(job)`, then the `daily_usage` row of kind `ai` (inside `reserveDaily`). Refunds take the same locks in the
 * same order and never lock a job.
 */
export const CAP_LOCKS = {
  openJobs: "cap:open_jobs",
  parts: "cap:parts",
  demoLoad: "cap:demo_load",
} as const;

/** Serializes the "at most N AI drafts per job per day" count-then-insert for one job. Taken after the job row lock. */
export const aiJobLock = (jobId: string) => `cap:ai_job:${jobId}`;

/** AI drafts: per user per hour (rate kind `ai`), and per job per rolling day (counted from `work_order_op`). */
export const AI_DRAFTS_PER_HOUR = 10;
export const AI_DRAFTS_PER_JOB_PER_DAY = 5;

/** Open (not completed or cancelled) jobs, app-wide. */
export const MAX_OPEN_JOBS = 2000;
/** Rows in the part catalog, active or not. */
export const MAX_PARTS = 500;

/** The live caps. A mutable holder only so tests can lower them for their own process; production never changes it. */
export const capLimits = { openJobs: MAX_OPEN_JOBS, parts: MAX_PARTS, aiPerJobDay: AI_DRAFTS_PER_JOB_PER_DAY };
