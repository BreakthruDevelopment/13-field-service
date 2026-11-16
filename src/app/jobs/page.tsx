import type { Metadata } from "next";
import Link from "next/link";
import { ZodError } from "zod";
import { type Column, DataList, FilterBar, PageIntro, Panel, StatGrid, StatTile, buttonPrimary, buttonSecondary } from "@/components/ui";
import { JobPriorityBadge, JobStatusBadge } from "@/components/job-status-badge";
import { PreferLocalTz } from "@/components/prefer-local-tz";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { listTechnicians } from "@/lib/board";
import { HttpError } from "@/lib/errors";
import { type JobPriority, JOB_STATUS_LABELS, formatWindow, isTimeZone } from "@/lib/job-display";
import { JOB_STATUSES } from "@/lib/job-status";
import { type JobSummary, listJobs } from "@/lib/service-jobs";

export const metadata: Metadata = { title: "Jobs" };
export const dynamic = "force-dynamic";
export const maxDuration = 25;

const LIMIT = 50;
const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

function jobsHref(opts: {
  q: string;
  status: string;
  assigneeId: string;
  view: string;
  offset: number;
  tz: string;
}) {
  const params = new URLSearchParams();
  if (opts.q) params.set("q", opts.q);
  if (opts.status) params.set("status", opts.status);
  if (opts.assigneeId) params.set("assigneeId", opts.assigneeId);
  if (opts.view === "cards") params.set("view", "cards");
  if (opts.offset) params.set("offset", String(opts.offset));
  if (opts.tz && opts.tz !== "UTC") params.set("tz", opts.tz);
  const query = params.toString();
  return query ? `/jobs?${query}` : "/jobs";
}

export default async function JobsPage({ searchParams }: PageProps<"/jobs">) {
  const user = await requireRoleOrRedirect("dispatcher");
  const sp = await searchParams;
  const q = one(sp.q).trim().slice(0, 100);
  const status = JOB_STATUSES.includes(one(sp.status) as (typeof JOB_STATUSES)[number]) ? one(sp.status) : "";
  const assigneeId = one(sp.assigneeId).trim();
  const view = one(sp.view) === "cards" ? "cards" : "table";
  const offsetRaw = Number(one(sp.offset));
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.min(Math.floor(offsetRaw), 10_000) : 0;
  const tzParam = one(sp.tz).trim();
  const tz = isTimeZone(tzParam) ? tzParam : "UTC";

  let listed: { jobs: JobSummary[]; hasMore: boolean } | null = null;
  let technicians: { id: string; name: string }[] = [];
  let loadError: string | null = null;
  try {
    const [jobs, techs] = await Promise.all([
      listJobs(user, {
        q: q || undefined,
        status: status || undefined,
        assigneeId: assigneeId || undefined,
        limit: LIMIT,
        offset,
      }),
      listTechnicians(user),
    ]);
    listed = jobs;
    technicians = techs.technicians;
  } catch (err) {
    if (err instanceof ZodError) loadError = err.issues[0]?.message ?? "Check the search and try again.";
    else if (err instanceof HttpError && err.status === 429) loadError = "Too many requests, try again in a minute.";
    else throw err;
  }

  const rows = listed?.jobs ?? [];
  const columns: Column<JobSummary>[] = [
    {
      key: "job",
      header: "Job",
      primary: true,
      cell: (job) => (
        <Link href={`/jobs/${job.id}`} className="min-w-0 font-semibold text-accent [overflow-wrap:anywhere] hover:underline">
          <span className="font-mono">#{job.number}</span> {job.title}
        </Link>
      ),
    },
    {
      key: "customer",
      header: "Customer",
      cell: (job) => <span className="min-w-0 [overflow-wrap:anywhere]">{job.customer.name}</span>,
    },
    {
      key: "site",
      header: "Site",
      cell: (job) => (
        <span className="min-w-0 [overflow-wrap:anywhere]">
          {job.site.label}: {job.site.address}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (job) => <JobStatusBadge status={job.status} />,
    },
    {
      key: "priority",
      header: "Priority",
      cell: (job) => <JobPriorityBadge priority={job.priority as JobPriority} />,
    },
    {
      key: "assignee",
      header: "Technician",
      cell: (job) => <span className="min-w-0 [overflow-wrap:anywhere]">{job.assignee?.name ?? "Unassigned"}</span>,
    },
    {
      key: "window",
      header: "Window",
      cell: (job) => formatWindow(job.scheduledStart, job.scheduledEnd, tz),
    },
  ];

  return (
    <>
      <PreferLocalTz path="/jobs" />
      <PageIntro
        section="Jobs"
        title="Jobs"
        description="Search and filter every job. Create a job to put it on the board, assigned or in the unassigned tray."
        actions={
          <>
            <Link href="/jobs/new" className={buttonPrimary}>
              New job
            </Link>
            <Link href="/board" className={buttonSecondary}>
              Schedule board
            </Link>
          </>
        }
      />
      <StatGrid>
        <StatTile value={rows.length} label="Jobs on this page" tone="accent" />
        <StatTile value={technicians.length} label="Technicians" />
      </StatGrid>
      <Panel title="Jobs" count={rows.length}>
        <FilterBar
          label="Filter jobs"
          search={{ value: q, placeholder: "Search title, customer, address or number…" }}
          hidden={tz !== "UTC" ? { tz } : {}}
          filters={[
            {
              name: "status",
              label: "Status",
              value: status,
              options: [
                { value: "", label: "Any status" },
                ...JOB_STATUSES.map((s) => ({ value: s, label: JOB_STATUS_LABELS[s] })),
              ],
            },
            {
              name: "assigneeId",
              label: "Technician",
              value: assigneeId,
              options: [
                { value: "", label: "Any technician" },
                ...technicians.map((t) => ({ value: t.id, label: t.name })),
              ],
            },
          ]}
          view={{ value: view }}
        />
        {loadError ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {loadError}
          </p>
        ) : (
          <DataList
            caption="Jobs"
            rows={rows}
            rowKey={(job) => job.id}
            columns={columns}
            view={view}
            empty={
              q || status || assigneeId
                ? "No jobs match those filters."
                : "No jobs yet. Create one to put it on the board."
            }
          />
        )}
        {(offset > 0 || listed?.hasMore) && (
          <div className="mt-4 flex flex-wrap gap-3">
            {offset > 0 && (
              <Link
                href={jobsHref({ q, status, assigneeId, view, offset: Math.max(0, offset - LIMIT), tz })}
                className={buttonSecondary}
              >
                Previous
              </Link>
            )}
            {listed?.hasMore && (
              <Link href={jobsHref({ q, status, assigneeId, view, offset: offset + LIMIT, tz })} className={buttonSecondary}>
                Next
              </Link>
            )}
          </div>
        )}
      </Panel>
    </>
  );
}
