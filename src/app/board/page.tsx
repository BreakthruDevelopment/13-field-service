import type { Metadata } from "next";
import Link from "next/link";
import { PageIntro, Panel, StatGrid, StatTile, buttonPrimary, buttonSecondary } from "@/components/ui";
import { JobCard } from "@/components/job-card";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { listBoard } from "@/lib/dispatch";
import { parseUtcDay, shiftUtcDay } from "@/lib/dispatch-view";
import { inputClass } from "@/components/ui/styles";
import { BoardPoll } from "./poll";

export const metadata: Metadata = { title: "Schedule board" };
export const dynamic = "force-dynamic";

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export default async function BoardPage({ searchParams }: PageProps<"/board">) {
  const user = await requireRoleOrRedirect("dispatcher");
  const sp = await searchParams;
  const date = parseUtcDay(one(sp.date));
  const board = await listBoard(user, date);
  const prev = shiftUtcDay(board.date, -1);
  const next = shiftUtcDay(board.date, 1);
  const scheduled = board.lanes.reduce((sum, lane) => sum + lane.jobs.length, 0);

  return (
    <>
      <BoardPoll />
      <PageIntro
        section="Schedule"
        title="Board"
        description="A dispatcher day, in UTC. Lanes stack on a phone. This page refreshes once a minute while you are looking at it."
        actions={
          <Link href="/jobs/new" className={buttonPrimary}>
            New job
          </Link>
        }
      />

      <StatGrid>
        <StatTile value={scheduled} label="On the board" tone="accent" />
        <StatTile value={board.unassigned.length} label="Unassigned" tone={board.unassigned.length > 0 ? "building" : "default"} />
        <StatTile value={board.lanes.length} label="Technicians" />
      </StatGrid>

      <form method="get" className="mb-6 flex flex-wrap items-end gap-3" aria-label="Board date">
        <label className="min-w-0 flex-1 basis-full space-y-1 text-sm font-medium sm:basis-auto sm:flex-none">
          <span>Date (UTC)</span>
          <input type="date" name="date" defaultValue={board.date} required className={inputClass} />
        </label>
        <button type="submit" className={buttonSecondary}>
          Show day
        </button>
        <Link href={`/board?date=${prev}`} className={buttonSecondary}>
          Previous day
        </Link>
        <Link href={`/board?date=${next}`} className={buttonSecondary}>
          Next day
        </Link>
      </form>

      {board.truncated && (
        <p role="status" className="mb-4 text-sm text-muted">
          Showing the first 200 jobs for this day.
        </p>
      )}

      <div className="grid min-w-0 gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <Panel title="Unassigned" count={board.unassigned.length}>
          {board.unassigned.length === 0 ? (
            <p className="text-sm text-muted">No unassigned jobs. New work without a technician shows up here.</p>
          ) : (
            <ul className="grid gap-3">
              {board.unassigned.map((job) => (
                <li key={job.id} className="min-w-0">
                  <JobCard job={job} />
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <div className="grid min-w-0 gap-4 md:grid-cols-2">
          {board.lanes.length === 0 ? (
            <Panel title="Technicians">
              <p className="text-sm text-muted">No technicians yet. An admin grants the technician role before you can assign a job.</p>
            </Panel>
          ) : (
            board.lanes.map((lane) => (
              <Panel key={lane.technicianId} title={lane.name} count={lane.jobs.length}>
                {lane.jobs.length === 0 ? (
                  <p className="text-sm text-muted">Nothing scheduled this day.</p>
                ) : (
                  <ul className="grid gap-3">
                    {lane.jobs.map((job) => (
                      <li key={job.id} className="min-w-0">
                        <JobCard job={job} />
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            ))
          )}
        </div>
      </div>
    </>
  );
}
