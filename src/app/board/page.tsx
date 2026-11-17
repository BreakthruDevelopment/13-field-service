import type { Metadata } from "next";
import Link from "next/link";
import { ZodError } from "zod";
import { PageIntro, Panel, StatGrid, StatTile, buttonPrimary, buttonSecondary, inputClass, labelClass } from "@/components/ui";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { type Board, getBoard } from "@/lib/board";
import { BadRequestError, HttpError } from "@/lib/errors";
import { isCalendarDate, isTimeZone, shiftCalendarDate, todayInTimeZone } from "@/lib/job-display";
import type { JobSummary } from "@/lib/service-jobs";
import { PreferLocalTz } from "@/components/prefer-local-tz";
import { BoardShell } from "./board-poller";
import { JobCard } from "./job-card";

export const metadata: Metadata = { title: "Schedule board" };
export const dynamic = "force-dynamic";
export const maxDuration = 25;

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

function boardHref(date: string, tz: string) {
  const params = new URLSearchParams({ date, tz });
  return `/board?${params.toString()}`;
}

function jobsByTechnician(jobs: JobSummary[]): Map<string, JobSummary[]> {
  const map = new Map<string, JobSummary[]>();
  for (const job of jobs) {
    const id = job.assignee?.id;
    if (!id) continue;
    const list = map.get(id) ?? [];
    list.push(job);
    map.set(id, list);
  }
  return map;
}

export default async function BoardPage({ searchParams }: PageProps<"/board">) {
  const user = await requireRoleOrRedirect("dispatcher");
  const sp = await searchParams;
  const tzParam = one(sp.tz).trim();
  const tz = isTimeZone(tzParam) ? tzParam : "UTC";
  const dateParam = one(sp.date).trim();
  const date = isCalendarDate(dateParam) ? dateParam : todayInTimeZone(tz);

  let board: Board | null = null;
  let loadError: string | null = null;
  let tzNote: string | null = null;

  try {
    board = await getBoard(user, { date, tz });
  } catch (err) {
    if (err instanceof ZodError) loadError = err.issues[0]?.message ?? "Check the date and try again.";
    else if (err instanceof BadRequestError && tz !== "UTC") {
      try {
        board = await getBoard(user, { date, tz: "UTC" });
        tzNote = "That time zone isn't available here. Times are shown in UTC.";
      } catch (retryErr) {
        if (retryErr instanceof HttpError && retryErr.status === 429) loadError = "Too many requests, try again in a minute.";
        else if (retryErr instanceof HttpError && retryErr.status < 500) loadError = retryErr.message;
        else throw retryErr;
      }
    } else if (err instanceof HttpError && err.status === 429) loadError = "Too many requests, try again in a minute.";
    else if (err instanceof HttpError && err.status < 500) loadError = err.message;
    else throw err;
  }

  const shownTz = board?.tz ?? (tzNote ? "UTC" : tz);
  const lanes = jobsByTechnician(board?.jobs ?? []);
  const unassigned = board?.unassigned ?? [];
  const technicians = board?.technicians ?? [];
  const prev = shiftCalendarDate(date, -1);
  const next = shiftCalendarDate(date, 1);
  const today = todayInTimeZone(shownTz);

  return (
    <BoardShell>
      <PreferLocalTz path="/board" withDate />
      <PageIntro
        section="Board"
        title="Schedule board"
        description="One day, a lane per technician, and the unassigned tray. The board refreshes every 60 seconds while this tab is open."
        actions={
          <>
            <Link href="/jobs/new" className={buttonPrimary}>
              New job
            </Link>
            <Link href="/jobs" className={buttonSecondary}>
              All jobs
            </Link>
          </>
        }
      />

      <form method="get" className="mb-6 flex min-w-0 flex-wrap items-end gap-3" aria-label="Pick a day">
        <Link href={boardHref(prev, shownTz)} className={buttonSecondary}>
          Previous day
        </Link>
        <label className={`${labelClass} min-w-0`}>
          <span>Date</span>
          <input type="date" name="date" defaultValue={date} required className={inputClass} />
        </label>
        <input type="hidden" name="tz" value={shownTz} />
        <button type="submit" className={buttonPrimary}>
          Show
        </button>
        <Link href={boardHref(next, shownTz)} className={buttonSecondary}>
          Next day
        </Link>
        {date !== today && (
          <Link href={boardHref(today, shownTz)} className={buttonSecondary}>
            Today
          </Link>
        )}
        <p className="text-sm text-muted">Times in {shownTz}.</p>
      </form>

      {tzNote ? (
        <p role="status" className="mb-4 text-sm text-muted">
          {tzNote}
        </p>
      ) : null}

      {loadError ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {loadError}
        </p>
      ) : (
        <>
          <StatGrid>
            <StatTile value={unassigned.length} label="Unassigned" tone={unassigned.length ? "building" : "default"} />
            <StatTile value={board?.jobs.length ?? 0} label="On this day" tone="accent" />
            <StatTile value={technicians.length} label="Technicians" />
          </StatGrid>

          {board?.truncated ? (
            <p role="status" className="mb-4 text-sm font-medium text-building">
              Showing the first 200 jobs. Some unassigned or later jobs are hidden.
            </p>
          ) : null}

          <Panel title="Unassigned" count={unassigned.length} collapsible={unassigned.length > 4} defaultOpen>
            {unassigned.length === 0 ? (
              <p className="text-sm text-muted">No unassigned jobs. New jobs without a technician land here.</p>
            ) : (
              <ul className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {unassigned.map((job) => (
                  <li key={job.id} className="min-w-0">
                    <JobCard job={job} tz={shownTz} date={date} technicians={technicians} assignable />
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <h2 className="mb-3 font-display text-2xl font-semibold">Technicians</h2>
          {technicians.length === 0 ? (
            <p className="text-sm text-muted">No technicians yet. An admin grants the technician role.</p>
          ) : (
            <div className="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-start lg:gap-3 lg:overflow-x-auto">
              {technicians.map((tech) => {
                const jobs = lanes.get(tech.id) ?? [];
                return (
                  <section
                    key={tech.id}
                    aria-label={tech.name}
                    className="min-w-0 rounded-card border border-border bg-surface p-4 lg:w-72 lg:min-w-64 lg:max-w-80 lg:shrink-0"
                  >
                    <h3 className="mb-3 min-w-0 font-display text-xl font-semibold [overflow-wrap:anywhere]">
                      {tech.name}
                      <span className="ml-2 rounded-md bg-idle-soft px-2 py-0.5 font-sans text-sm font-medium text-idle">
                        {jobs.length}
                      </span>
                    </h3>
                    {jobs.length === 0 ? (
                      <p className="text-sm text-muted">No jobs this day.</p>
                    ) : (
                      <ul className="grid min-w-0 gap-3">
                        {jobs.map((job) => (
                          <li key={job.id} className="min-w-0">
                            <JobCard job={job} tz={shownTz} date={date} technicians={technicians} assignable={false} />
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                );
              })}
            </div>
          )}
        </>
      )}
    </BoardShell>
  );
}
