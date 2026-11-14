import type { Metadata } from "next";
import Link from "next/link";
import { type Column, DataList, FilterBar, PageIntro, Panel, StatGrid, StatTile, StatusBadge, buttonPrimary, buttonSecondary } from "@/components/ui";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { type DispatchJob, listDispatchJobs, listTechnicians } from "@/lib/dispatch";
import { JOB_PRIORITIES, SERVICE_JOB_STATUSES } from "@/lib/db/schema";
import { formatWindow, jobPriorityLabel, jobStatusLabel, jobStatusTone } from "@/lib/dispatch-view";

export const metadata: Metadata = { title: "Jobs" };
export const dynamic = "force-dynamic";

const sorts = [
  { value: "newest", label: "Newest first" },
  { value: "scheduled", label: "Scheduled time" },
  { value: "priority", label: "Priority" },
];

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

export default async function JobsPage({ searchParams }: PageProps<"/jobs">) {
  const user = await requireRoleOrRedirect("dispatcher");
  const sp = await searchParams;
  const q = one(sp.q).trim().slice(0, 100);
  const status = one(sp.status);
  const priority = one(sp.priority);
  const assignee = one(sp.assignee) || "all";
  const sort = sorts.some((item) => item.value === one(sp.sort)) ? one(sp.sort) : "newest";
  const view = one(sp.view) === "cards" ? "cards" : "table";

  const [jobs, technicians] = await Promise.all([
    listDispatchJobs(user, { q, status, priority, assignee, sort }),
    listTechnicians(user),
  ]);

  const columns: Column<DispatchJob>[] = [
    {
      key: "title",
      header: "Job",
      primary: true,
      cell: (job) => (
        <span className="break-words">
          <span className="mr-2 font-mono text-sm text-muted">#{job.number}</span>
          {job.title}
        </span>
      ),
    },
    {
      key: "customer",
      header: "Customer",
      cell: (job) => <span className="break-words">{job.customerName}</span>,
    },
    {
      key: "site",
      header: "Site",
      cell: (job) => (
        <span className="break-words">
          {job.siteLabel} · {job.siteAddress}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (job) => <StatusBadge status={jobStatusTone(job.status)} label={jobStatusLabel(job.status)} />,
    },
    {
      key: "priority",
      header: "Priority",
      cell: (job) => jobPriorityLabel(job.priority),
    },
    {
      key: "when",
      header: "When",
      cell: (job) => <span className="break-words">{formatWindow(job.scheduledStart, job.scheduledEnd)}</span>,
    },
    {
      key: "assignee",
      header: "Technician",
      cell: (job) => <span className="break-words">{job.assigneeName ?? "Unassigned"}</span>,
    },
  ];

  const statusOptions = [{ value: "", label: "Any status" }, ...SERVICE_JOB_STATUSES.map((value) => ({ value, label: jobStatusLabel(value) }))];
  const priorityOptions = [{ value: "", label: "Any priority" }, ...JOB_PRIORITIES.map((value) => ({ value, label: jobPriorityLabel(value) }))];
  const assigneeOptions = [
    { value: "all", label: "Anyone" },
    { value: "unassigned", label: "Unassigned" },
    ...technicians.map((tech) => ({ value: tech.id, label: tech.name })),
  ];

  return (
    <>
      <PageIntro
        section="Jobs"
        title="Jobs"
        description="Every job the office can see. Filter the list, then open the board to see the day."
        actions={
          <>
            <Link href="/jobs/new" className={buttonPrimary}>
              New job
            </Link>
            <Link href="/board" className={buttonSecondary}>
              Board
            </Link>
          </>
        }
      />
      <StatGrid>
        <StatTile value={jobs.length} label={q || status || priority || assignee !== "all" ? "Matching jobs" : "Jobs shown"} tone="accent" />
        <StatTile value={jobs.filter((job) => job.status === "unassigned").length} label="Unassigned in this list" />
      </StatGrid>
      <Panel title="All jobs" count={jobs.length}>
        <FilterBar
          label="Filter jobs"
          search={{ value: q, placeholder: "Search title, customer, or address…" }}
          filters={[
            { name: "status", label: "Status", value: status, options: statusOptions },
            { name: "priority", label: "Priority", value: priority, options: priorityOptions },
            { name: "assignee", label: "Technician", value: assignee, options: assigneeOptions },
          ]}
          sort={{ name: "sort", label: "Sort", value: sort, options: sorts }}
          view={{ value: view }}
        />
        <DataList
          caption="Jobs"
          rows={jobs}
          rowKey={(job) => job.id}
          columns={columns}
          view={view}
          empty={
            q || status || priority || assignee !== "all"
              ? "No jobs match these filters."
              : "No jobs yet. Create the first one and it will show up here and on the board."
          }
        />
      </Panel>
    </>
  );
}
