import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { EmailLink, Fact, FactList, PhoneLink, wrapText } from "@/components/fact";
import { JobStatusBadge, WorkOrderStatusBadge } from "@/components/job-status-badge";
import { LoadProblem } from "@/components/load-problem";
import { LocalTime } from "@/components/local-time";
import { OsmLink } from "@/components/osm-link";
import { DemoBadge, PageIntro, Panel, StatGrid, StatTile, StatusBadge, buttonSecondary } from "@/components/ui";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { listTechnicians, type TechnicianDto } from "@/lib/board";
import { JOB_PRIORITIES } from "@/lib/db/schema";
import {
  eventSummary,
  formatCheckIn,
  formatQty,
  lineFlagLabel,
  safetyLabel,
  statusActionLabel,
  unitLabel,
  type WorkOrderStatus,
} from "@/lib/field-format";
import { JOB_PRIORITY_LABELS, JOB_STATUS_LABELS } from "@/lib/job-display";
import { readFailure } from "@/lib/form-errors";
import { ACTIVE_STATUSES, FINAL_STATUSES, WORK_TRANSITIONS, transitionNeedsNote } from "@/lib/job-status";
import { getJob, type JobDetail, type JobEventDto } from "@/lib/service-jobs";
import { getWorkOrder, type WorkOrderDto } from "@/lib/work-orders";
import {
  AddNoteForm,
  AssignForm,
  CancelForm,
  EditJobForm,
  ReopenForm,
  RescheduleForm,
  StatusForm,
  UnassignForm,
  WorkOrderDecision,
} from "./forms";

export const metadata: Metadata = { title: "Job" };
export const dynamic = "force-dynamic";
export const maxDuration = 25;

const priorities = JOB_PRIORITIES.map((value) => ({ value, label: JOB_PRIORITY_LABELS[value] }));

export default async function JobPage({ params }: PageProps<"/jobs/[id]">) {
  const user = await requireRoleOrRedirect("dispatcher");
  const { id } = await params;

  const [jobResult, workOrderResult, techResult] = await Promise.allSettled([
    getJob(user, id),
    getWorkOrder(user, id),
    listTechnicians(user),
  ]);

  if (jobResult.status === "rejected") {
    const failure = readFailure(jobResult.reason);
    if (failure === "missing") notFound();
    return <LoadProblem section="Jobs" title="Job" message={failure} />;
  }

  const job = jobResult.value;
  let workOrder: WorkOrderDto | null = null;
  let workOrderError: string | null = null;
  if (workOrderResult.status === "fulfilled") workOrder = workOrderResult.value;
  else {
    const failure = readFailure(workOrderResult.reason);
    if (failure === "missing") notFound();
    workOrderError = failure;
  }

  let technicians: TechnicianDto[] = [];
  let techError: string | null = null;
  if (techResult.status === "fulfilled") technicians = techResult.value.technicians;
  else {
    const failure = readFailure(techResult.reason);
    techError = failure === "missing" ? "Technicians could not be loaded." : failure;
  }

  const closed = FINAL_STATUSES.includes(job.status);
  const checkIns = job.events.filter((event) => event.checkIn);
  const statusActions = WORK_TRANSITIONS[job.status].map((to) => ({
    to,
    label: statusActionLabel(to),
    needsNote: transitionNeedsNote(to) && job.notes.length < 1,
  }));
  const ids = { id: job.id, customerId: job.customer.id, version: job.version };

  return (
    <>
      <PageIntro
        section="Jobs"
        title={job.title}
        description={`Job #${job.number}`}
        actions={
          <Link href={`/customers/${job.customer.id}`} className={`${buttonSecondary} w-full sm:w-auto`}>
            View customer
          </Link>
        }
      />
      <StatGrid>
        <StatTile value={JOB_STATUS_LABELS[job.status]} label="Status" tone="accent" />
        <StatTile value={JOB_PRIORITY_LABELS[job.priority]} label="Priority" />
        <StatTile value={`#${job.number}`} label="Job number" />
        <StatTile value={job.notes.length} label={job.notes.length === 1 ? "Note" : "Notes"} />
      </StatGrid>

      <Panel title="Job">
        <FactList>
          <Fact label="Customer">
            <Link href={`/customers/${job.customer.id}`} className={`${wrapText} font-semibold text-accent hover:underline`}>
              {job.customer.name}
            </Link>
          </Fact>
          <Fact label="Phone">
            <PhoneLink phone={job.customer.phone} />
          </Fact>
          <Fact label="Email">{job.customerDetail?.email ? <EmailLink email={job.customerDetail.email} /> : "—"}</Fact>
          <Fact label="Customer notes" wide>
            {job.customerDetail?.notes ? <span className="whitespace-pre-wrap">{job.customerDetail.notes}</span> : "No customer notes."}
          </Fact>
          <Fact label="Site">{job.site.label}</Fact>
          <Fact label="Address">
            <span className="whitespace-pre-wrap">{job.site.address}</span>
          </Fact>
          <Fact label="Access notes" wide>
            {job.siteDetail.accessNotes ? <span className="whitespace-pre-wrap">{job.siteDetail.accessNotes}</span> : "No access notes."}
          </Fact>
          <Fact label="Site coordinates" wide>
            {job.siteDetail.lat !== null && job.siteDetail.lng !== null ? (
              <span className="flex flex-col items-start gap-2">
                <span>
                  {job.siteDetail.lat}, {job.siteDetail.lng}
                </span>
                <OsmLink lat={job.siteDetail.lat} lng={job.siteDetail.lng} />
              </span>
            ) : (
              "No coordinates on this site, so a check-in can't show a distance."
            )}
          </Fact>
          <Fact label="Technician">{job.assignee?.name ?? "Unassigned"}</Fact>
          <Fact label="Window">
            {job.scheduledStart && job.scheduledEnd ? (
              <>
                <LocalTime iso={job.scheduledStart} />
                <span aria-hidden> – </span>
                <span className="sr-only"> to </span>
                <LocalTime iso={job.scheduledEnd} />
              </>
            ) : (
              "Not scheduled"
            )}
          </Fact>
          <Fact label="Description" wide>
            {job.description ? <span className="whitespace-pre-wrap">{job.description}</span> : "No description."}
          </Fact>
        </FactList>
        {!closed && (
          <div className="mt-4">
            <EditJobForm job={{ ...ids, title: job.title, description: job.description, priority: job.priority }} priorities={priorities} />
          </div>
        )}
      </Panel>

      <Panel title="Check-in" count={checkIns.length}>
        {checkIns.length === 0 ? (
          <p className="rounded-card bg-background px-4 py-6 text-center text-sm text-muted">
            No check-in yet. The technician&apos;s phone sends a location only when they tap Check in at site.
          </p>
        ) : (
          <ul className="grid gap-4">
            {checkIns.map((event) => (
              <CheckInItem key={event.id} event={event} />
            ))}
          </ul>
        )}
        <p className="mt-3 text-sm text-muted">
          Device-reported. Stored to about 11 m and removed 90 days after the job is completed.
        </p>
      </Panel>

      <WorkOrderPanel job={job} order={workOrder} error={workOrderError} />

      <Panel title="Assignment and schedule">
        {closed ? (
          <p className="text-sm text-muted">
            {job.status === "cancelled" ? "This job is cancelled and stays closed." : "Reopen the job before assigning or rescheduling it."}
          </p>
        ) : (
          <div className="grid min-w-0 gap-6 lg:grid-cols-2">
            <div className="min-w-0 space-y-3">
              <h3 className="font-display text-xl font-semibold">Assign</h3>
              <AssignForm job={ids} technicians={technicians} techError={techError} />
              {ACTIVE_STATUSES.includes(job.status) && <UnassignForm job={ids} />}
            </div>
            <div className="min-w-0 space-y-3">
              <h3 className="font-display text-xl font-semibold">Schedule</h3>
              <RescheduleForm job={{ ...ids, scheduledStart: job.scheduledStart, scheduledEnd: job.scheduledEnd }} />
            </div>
          </div>
        )}
      </Panel>

      <Panel title="Status">
        <div className="mb-4">
          <JobStatusBadge status={job.status} />
        </div>
        <div className="grid min-w-0 gap-4">
          <StatusForm job={ids} actions={statusActions} needsNote={statusActions.some((item) => item.needsNote)} />
          {(job.status === "completed" || job.status === "on_hold") && <ReopenForm job={ids} />}
          {!closed && <CancelForm job={ids} />}
          {job.status === "cancelled" && <p className="text-sm text-muted">Cancelled jobs stay closed.</p>}
        </div>
      </Panel>

      <Panel title="Notes" count={job.notes.length}>
        {job.notes.length === 0 ? (
          <p className="mb-4 rounded-card bg-background px-4 py-6 text-center text-sm text-muted">No notes yet.</p>
        ) : (
          <ul className="mb-4 grid gap-3">
            {job.notes.map((note) => (
              <li key={note.id} className="min-w-0 rounded-card border border-border bg-background px-3 py-3">
                <p className="whitespace-pre-wrap wrap-anywhere">{note.body}</p>
                <p className="mt-2 text-sm text-muted">
                  <span className={wrapText}>{note.authorName}</span>
                  {" · "}
                  <LocalTime iso={note.serverAt} />
                </p>
              </li>
            ))}
          </ul>
        )}
        <AddNoteForm job={{ id: job.id, customerId: job.customer.id }} />
      </Panel>

      <Panel title="History" count={job.events.length}>
        {job.events.length === 0 ? (
          <p className="rounded-card bg-background px-4 py-6 text-center text-sm text-muted">No history yet.</p>
        ) : (
          <ol className="grid gap-4">
            {job.events.map((event) => (
              <li key={event.id} className="min-w-0 border-l-2 border-border pl-3">
                <p className="font-medium">{eventSummary(event)}</p>
                <p className="text-sm text-muted">
                  <span className={wrapText}>{event.actorName}</span>
                  {" · "}
                  <LocalTime iso={event.serverAt} />
                </p>
                {event.checkIn && (
                  <p className="mt-1 text-sm">{formatCheckIn(event.checkIn)}</p>
                )}
              </li>
            ))}
          </ol>
        )}
      </Panel>
    </>
  );
}

function CheckInItem({ event }: { event: JobEventDto }) {
  if (!event.checkIn) return null;
  const checkIn = event.checkIn;
  return (
    <li className="min-w-0 space-y-2">
      <p className={wrapText}>{formatCheckIn(checkIn)}</p>
      <p className="text-sm text-muted">
        <span className={wrapText}>{event.actorName}</span>
        {checkIn.capturedAt && (
          <>
            {" · device time "}
            <LocalTime iso={checkIn.capturedAt} />
          </>
        )}
      </p>
      <OsmLink lat={checkIn.lat} lng={checkIn.lng} />
    </li>
  );
}

function WorkOrderPanel({ job, order, error }: { job: JobDetail; order: WorkOrderDto | null; error: string | null }) {
  return (
    <Panel title="Work order" count={order ? order.lines.length : undefined}>
      {error ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : !order ? (
        <p className="rounded-card bg-background px-4 py-6 text-center text-sm text-muted">
          No work order yet. The technician drafts one from the job notes, then submits it for you to approve or return.
        </p>
      ) : (
        <WorkOrderBody job={job} order={order} />
      )}
    </Panel>
  );
}

function WorkOrderBody({ job, order }: { job: JobDetail; order: WorkOrderDto }) {
  const status = order.status as WorkOrderStatus;
  const cancelled = job.status === "cancelled";
  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <WorkOrderStatusBadge status={status} />
        {order.ai?.demo && <DemoBadge label="Recorded draft" />}
      </div>
      <p className="text-sm text-muted">{workOrderLead(status, cancelled)}</p>
      {order.returnReason && (
        <p className={`${wrapText} rounded-card bg-blocked-soft px-3 py-2 text-sm text-blocked`}>
          Returned: {order.returnReason}
        </p>
      )}
      {order.ai?.needsHumanBecause && (
        <p className={`${wrapText} rounded-card bg-blocked-soft px-3 py-2 text-sm text-blocked`}>
          Needs a person: {order.ai.needsHumanBecause}
        </p>
      )}
      {order.safety.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Safety: check before closing</h3>
          <ul className="flex flex-wrap gap-2">
            {order.safety.map((chip) => (
              <li key={chip.code}>
                <StatusBadge status="blocked" label={`${safetyLabel(chip.code)} (“${chip.phrase}”)`} />
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">Summary</h3>
        <p className="whitespace-pre-wrap wrap-anywhere">{order.summary || "No summary."}</p>
      </div>
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">Tasks</h3>
        {order.tasks.length === 0 ? (
          <p className="text-sm text-muted">No tasks.</p>
        ) : (
          <ul className="grid gap-2">
            {order.tasks.map((task, index) => (
              <li key={`${index}-${task.description}`} className="flex min-w-0 gap-3 text-sm">
                <span className="shrink-0 font-medium text-muted">{task.state === "done" ? "Done" : "To do"}</span>
                <span className={wrapText}>{task.description}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {order.followUp && (
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Follow-up</h3>
          <p className="whitespace-pre-wrap wrap-anywhere">{order.followUp}</p>
        </div>
      )}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">Parts</h3>
        {order.lines.length === 0 ? (
          <p className="text-sm text-muted">No parts on this work order.</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {order.lines.map((line) => (
              <li key={line.id} className="min-w-0 space-y-2 rounded-card border border-border p-3">
                <p className={`${wrapText} font-medium`}>{line.mentioned}</p>
                <p className={`text-sm text-muted ${wrapText}`}>
                  {formatQty(line.qty)} {unitLabel(line.unit)} · {line.used === "used" ? "Used" : "Needed"}
                  {line.sku ? ` · ${line.sku}` : ""}
                  {line.partName ? ` · ${line.partName}` : ""}
                </p>
                <p className="text-sm text-muted">{line.source === "ai" ? "From the draft" : "Edited"}</p>
                {line.flags.length > 0 && (
                  <ul className="flex flex-wrap gap-2">
                    {line.flags.map((flag) => (
                      <li key={flag}>
                        <StatusBadge
                          status={flag === "unknown_part" || flag === "qty_check" ? "blocked" : "building"}
                          label={lineFlagLabel(flag)}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {order.ai && order.ai.dropped.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Dropped from the draft</h3>
          <ul className="grid gap-1 text-sm">
            {order.ai.dropped.map((row, index) => (
              <li key={`${index}-${row.mentioned}`} className={wrapText}>
                {row.mentioned} — not in the job notes
              </li>
            ))}
          </ul>
        </div>
      )}
      {status === "submitted" && !cancelled && (
        <WorkOrderDecision job={{ id: job.id, customerId: job.customer.id, version: order.version }} />
      )}
    </div>
  );
}

function workOrderLead(status: WorkOrderStatus, cancelled: boolean): ReactNode {
  if (cancelled && status !== "approved") return "This job was cancelled, so its work order can't be changed.";
  if (status === "approved") return "Approved. This work order is read-only.";
  if (status === "draft") return "Draft. The technician still needs to submit it before you can approve or return it.";
  if (status === "returned") return "Returned to the technician. They can edit it and submit it again.";
  return "Ready for review. Approve it, or return it with what to fix.";
}
