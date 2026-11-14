import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ZodError } from "zod";
import { type Column, DataList, DemoBadge, PageIntro, Panel, StatGrid, StatTile, StatusBadge, buttonSecondary } from "@/components/ui";
import type { Status } from "@/components/ui";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { checkInView, osmUrl, parseCoord } from "@/lib/check-in";
import { telHref } from "@/lib/contact";
import { formatWindow, jobPriorityLabel, jobStatusLabel, jobStatusTone, toUtcInput } from "@/lib/dispatch-view";
import { NotFoundError } from "@/lib/errors";
import { type JobDetail, type JobEventView, type WorkOrderLineView, getJobDetail, listTechnicians } from "@/lib/job-detail";
import type { WorkOrderStatus } from "@/lib/db/schema";
import { ApproveWorkOrderForm, AssignForm, CancelJobForm, ReopenJobForm, RescheduleForm, ReturnWorkOrderForm } from "./forms";

export const metadata: Metadata = { title: "Job" };
export const dynamic = "force-dynamic";

const ORDER_TONE: Record<WorkOrderStatus, Status> = {
  draft: "not-started",
  submitted: "building",
  approved: "healthy",
  returned: "degraded",
};

const ORDER_LABEL: Record<WorkOrderStatus, string> = {
  draft: "Draft",
  submitted: "Submitted",
  approved: "Approved",
  returned: "Returned",
};

const EVENT_LABEL: Record<JobEventView["kind"], string> = {
  created: "Created",
  assigned: "Assigned",
  unassigned: "Unassigned",
  rescheduled: "Rescheduled",
  status: "Status",
};

const FLAG_LABEL: Record<string, string> = {
  unknown_part: "Not in catalog",
  unit_mismatch: "Unit differs from catalog",
  non_integer: "Quantity should be a whole number",
  qty_check: "Check the quantity",
};

function formatWhen(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function formatQty(value: string): string {
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : value;
}

function MapAnchor({ href, children }: { href: string; children: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="font-semibold text-accent hover:underline">
      {children} <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

function CheckIn({ event, siteLat, siteLng }: { event: JobEventView; siteLat: string | null; siteLng: string | null }) {
  const view = checkInView({
    lat: parseCoord(event.lat),
    lng: parseCoord(event.lng),
    accuracyM: event.accuracyM,
    late: event.late,
    siteLat: parseCoord(siteLat),
    siteLng: parseCoord(siteLng),
  });
  if (!view) return null;
  return (
    <div className="mt-2 min-w-0 space-y-1">
      <p className="break-words">{view.summary}</p>
      <p className="text-sm text-muted">Device-reported</p>
      <p className="font-mono text-sm break-all">
        {event.lat}, {event.lng}
      </p>
      <MapAnchor href={view.osmUrl}>OpenStreetMap</MapAnchor>
    </div>
  );
}

export default async function JobDetailPage({ params }: PageProps<"/jobs/[id]">) {
  const user = await requireRoleOrRedirect("dispatcher");
  const { id } = await params;
  let job: JobDetail;
  let technicians: Awaited<ReturnType<typeof listTechnicians>> = [];
  try {
    [job, technicians] = await Promise.all([getJobDetail(user, id), listTechnicians(user)]);
  } catch (err) {
    if (err instanceof NotFoundError || err instanceof ZodError) notFound();
    throw err;
  }

  if (job.assigneeId && !technicians.some((tech) => tech.id === job.assigneeId)) {
    technicians = [{ id: job.assigneeId, name: job.assigneeName ?? "Assigned technician", email: "" }, ...technicians];
  }

  const tel = job.customer.phone ? telHref(job.customer.phone) : null;
  const siteLat = parseCoord(job.site.lat);
  const siteLng = parseCoord(job.site.lng);
  const checkIns = job.events.filter((event) => event.lat && event.lng).length;
  const open = job.status !== "completed" && job.status !== "cancelled";
  const canReopen = job.status === "completed" || job.status === "on_hold";
  const order = job.workOrder;

  const lineColumns: Column<WorkOrderLineView>[] = [
    {
      key: "part",
      header: "Part",
      primary: true,
      cell: (line) => (
        <span className="break-words">
          {line.sku ? <span className="mr-2 font-mono text-sm text-muted">{line.sku}</span> : null}
          {line.partName ?? line.mentioned}
          {line.sku && line.mentioned !== line.partName ? <span className="mt-1 block text-sm text-muted">{line.mentioned}</span> : null}
        </span>
      ),
    },
    {
      key: "qty",
      header: "Qty",
      cell: (line) => (
        <span className="break-words">
          {formatQty(line.qty)} {line.unit}
        </span>
      ),
    },
    { key: "used", header: "Used", cell: (line) => (line.used === "used" ? "Used" : "Needed") },
    {
      key: "flags",
      header: "Checks",
      cell: (line) =>
        line.flags.length === 0 ? (
          <span className="text-muted">None</span>
        ) : (
          <span className="break-words">{line.flags.map((flag) => FLAG_LABEL[flag] ?? flag).join(", ")}</span>
        ),
    },
  ];

  return (
    <>
      <PageIntro
        section={`Job ${job.number}`}
        title={job.title}
        description={`${job.customer.name} · ${job.site.label}`}
        actions={
          <Link href={`/customers/${job.customer.id}`} className={buttonSecondary}>
            Customer record
          </Link>
        }
      />
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <StatusBadge status={jobStatusTone(job.status)} label={jobStatusLabel(job.status)} />
        <span className="text-sm text-muted">{jobPriorityLabel(job.priority)} priority</span>
      </div>
      <StatGrid>
        <StatTile value={job.notes.length} label="Notes" tone="accent" />
        <StatTile value={checkIns} label="Check-ins" />
        <StatTile value={order?.lines.length ?? 0} label="Parts" />
      </StatGrid>

      <Panel title="Place">
        <div className="min-w-0 space-y-2">
          <p className="break-words">
            <Link href={`/customers/${job.customer.id}`} className="font-semibold text-accent hover:underline">
              {job.customer.name}
            </Link>
          </p>
          {tel ? (
            <p>
              <a href={tel} className="text-accent hover:underline break-words">
                {job.customer.phone}
              </a>
            </p>
          ) : job.customer.phone ? (
            <p className="break-words">{job.customer.phone}</p>
          ) : null}
          <p className="break-words">
            {job.site.label} · {job.site.address}
          </p>
          {job.site.accessNotes ? <p className="break-words text-sm text-muted">{job.site.accessNotes}</p> : null}
          {siteLat != null && siteLng != null && job.site.lat && job.site.lng ? (
            <p className="text-sm">
              <span className="font-mono break-all">
                {job.site.lat}, {job.site.lng}
              </span>{" "}
              <MapAnchor href={osmUrl(siteLat, siteLng, 5)}>Site on OpenStreetMap</MapAnchor>
            </p>
          ) : null}
          {job.description ? <p className="break-words">{job.description}</p> : null}
        </div>
      </Panel>

      <Panel title="Schedule">
        <p className="mb-4 break-words">
          {job.assigneeName ?? "Unassigned"} · {formatWindow(job.scheduledStart, job.scheduledEnd)}
        </p>
        {open ? (
          <div className="space-y-8">
            <AssignForm
              key={`assign-${job.version}`}
              jobId={job.id}
              version={job.version}
              assigneeId={job.assigneeId}
              technicians={technicians}
              scheduledStart={toUtcInput(job.scheduledStart)}
              scheduledEnd={toUtcInput(job.scheduledEnd)}
            />
            {job.assigneeId ? (
              <RescheduleForm
                key={`time-${job.version}`}
                jobId={job.id}
                version={job.version}
                scheduledStart={toUtcInput(job.scheduledStart)}
                scheduledEnd={toUtcInput(job.scheduledEnd)}
              />
            ) : null}
            <CancelJobForm key={`cancel-${job.version}`} jobId={job.id} version={job.version} />
          </div>
        ) : (
          <p className="text-sm text-muted">This job is {jobStatusLabel(job.status).toLowerCase()}. Assignment is closed.</p>
        )}
        {canReopen ? <div className="mt-4"><ReopenJobForm key={`reopen-${job.version}`} jobId={job.id} version={job.version} /></div> : null}
      </Panel>

      <Panel title="Notes" count={job.notes.length}>
        {job.notes.length === 0 ? (
          <p className="rounded-card bg-background px-4 py-6 text-center text-sm text-muted">No notes yet.</p>
        ) : (
          <ul className="grid gap-3">
            {job.notes.map((note) => (
              <li key={note.id} className="min-w-0 rounded-card border border-border p-4">
                <p className="break-words">{note.body}</p>
                <p className="mt-2 text-sm text-muted break-words">
                  {note.authorName} · {formatWhen(note.serverAt)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Activity" count={job.events.length}>
        {job.events.length === 0 ? (
          <p className="rounded-card bg-background px-4 py-6 text-center text-sm text-muted">No activity yet.</p>
        ) : (
          <ol className="grid gap-3">
            {job.events.map((event) => (
              <li key={event.id} className="min-w-0 rounded-card border border-border p-4">
                <p className="font-semibold">{EVENT_LABEL[event.kind]}</p>
                {event.fromStatus && event.toStatus && event.fromStatus !== event.toStatus ? (
                  <p className="text-sm">
                    {jobStatusLabel(event.fromStatus)} → {jobStatusLabel(event.toStatus)}
                  </p>
                ) : null}
                <p className="text-sm text-muted break-words">
                  {event.actorName} · {formatWhen(event.serverAt)}
                </p>
                <CheckIn event={event} siteLat={job.site.lat} siteLng={job.site.lng} />
              </li>
            ))}
          </ol>
        )}
      </Panel>

      <Panel
        title="Work order"
        action={
          order ? (
            <span className="flex flex-wrap items-center gap-2">
              {order.demo ? <DemoBadge /> : null}
              <StatusBadge status={ORDER_TONE[order.status]} label={ORDER_LABEL[order.status]} />
            </span>
          ) : undefined
        }
      >
        {!order ? (
          <p className="rounded-card bg-background px-4 py-6 text-center text-sm text-muted">
            No work order yet. The technician drafts one from the job notes, then submits it for review.
          </p>
        ) : (
          <div className="min-w-0 space-y-4">
            {order.aiUnreadable ? (
              <p role="alert" className="text-sm font-medium text-danger">
                The draft details could not be read.
              </p>
            ) : null}
            {order.tasksUnreadable ? (
              <p role="alert" className="text-sm font-medium text-danger">
                The task list could not be read.
              </p>
            ) : null}
            {order.summary ? <p className="break-words">{order.summary}</p> : <p className="text-sm text-muted">No summary.</p>}
            {order.submittedByName ? <p className="text-sm text-muted break-words">Submitted by {order.submittedByName}.</p> : null}
            {order.approvedByName ? <p className="text-sm text-muted break-words">Approved by {order.approvedByName}.</p> : null}
            {order.safety.length > 0 ? (
              <ul className="flex flex-wrap gap-2">
                {order.safety.map((phrase) => (
                  <li key={phrase} className="rounded-md bg-building-soft px-2 py-1 text-sm font-medium text-building break-words">
                    Safety: check before closing — {phrase}
                  </li>
                ))}
              </ul>
            ) : null}
            {order.tasks.length > 0 ? (
              <ul className="grid gap-2">
                {order.tasks.map((task) => (
                  <li key={task.description} className="flex min-w-0 items-start justify-between gap-3 text-sm">
                    <span className="min-w-0 break-words">{task.description}</span>
                    <span className="shrink-0 text-muted">{task.state === "done" ? "Done" : "To do"}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <DataList caption="Parts on this work order" columns={lineColumns} rows={order.lines} rowKey={(line) => line.id} empty="No parts on this work order." />
            {order.followUp ? (
              <p className="break-words">
                <span className="font-semibold">Follow-up. </span>
                {order.followUp}
              </p>
            ) : null}
            {order.dropped.length > 0 ? (
              <div>
                <h3 className="mb-2 font-semibold">Left off the parts list</h3>
                <ul className="grid gap-1 text-sm">
                  {order.dropped.map((row) => (
                    <li key={`${row.mentioned}-${row.reason}`} className="break-words">
                      {row.mentioned} <span className="text-muted">({row.reason.replaceAll("_", " ")})</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {order.returnReason ? (
              <p className="break-words rounded-card bg-building-soft px-3 py-2 text-sm text-building">Returned: {order.returnReason}</p>
            ) : null}
            {order.status === "draft" ? (
              <p className="text-sm text-muted">The technician has not submitted this work order yet.</p>
            ) : null}
            {order.status === "approved" ? <p className="text-sm text-muted">Approved work orders are read-only.</p> : null}
            {order.status === "submitted" ? (
              <div className="grid gap-6 border-t border-border pt-4 lg:grid-cols-2">
                <ApproveWorkOrderForm key={`approve-${order.version}`} jobId={job.id} version={order.version} />
                <ReturnWorkOrderForm key={`return-${order.version}`} jobId={job.id} version={order.version} />
              </div>
            ) : null}
          </div>
        )}
      </Panel>
    </>
  );
}
