"use client";

import { useState, useSyncExternalStore } from "react";
import { FormError } from "@/components/form-error";
import { useSavedForm } from "@/components/use-saved-form";
import { buttonDanger, buttonPrimary, buttonSecondary, inputClass, labelClass } from "@/components/ui/styles";
import { addNoteAction, updateJobAction, workOrderAction } from "./actions";

const textareaClass =
  "min-h-28 w-full rounded-card border border-border-strong bg-surface px-3 py-2 text-base text-foreground placeholder:text-muted focus:border-accent";

type Ids = { id: string; customerId: string; version: number };

function toIsoFromLocal(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return trimmed;
  return date.toISOString();
}

/** `datetime-local` is the browser's zone. Filled after mount so server and client HTML match. */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function prepareWindow(form: FormData) {
  for (const name of ["scheduledStart", "scheduledEnd"] as const) {
    const raw = form.get(name);
    form.set(name, toIsoFromLocal(typeof raw === "string" ? raw : ""));
  }
}

function HiddenJob({ job }: { job: Ids }) {
  return (
    <>
      <input type="hidden" name="id" value={job.id} />
      <input type="hidden" name="customerId" value={job.customerId} />
      <input type="hidden" name="version" value={job.version} />
    </>
  );
}

export function EditJobForm({
  job,
  priorities,
}: {
  job: Ids & { title: string; description: string; priority: string };
  priorities: { value: string; label: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useSavedForm(updateJobAction, { onOk: () => setOpen(false) });
  return (
    <div className="min-w-0 space-y-3">
      <button type="button" className={`${buttonSecondary} w-full sm:w-auto`} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? "Close" : "Edit details"}
      </button>
      {open && (
        <form action={action} aria-busy={pending} className="min-w-0 space-y-3">
          <HiddenJob job={job} />
          <input type="hidden" name="op" value="edit" />
          <EditFields key={job.version} job={job} priorities={priorities} />
          <FormError message={state.error} />
          <button type="submit" disabled={pending} className={`${buttonPrimary} w-full sm:w-auto`}>
            {pending ? "Saving…" : "Save details"}
          </button>
        </form>
      )}
    </div>
  );
}

function EditFields({
  job,
  priorities,
}: {
  job: { title: string; description: string; priority: string };
  priorities: { value: string; label: string }[];
}) {
  const [title, setTitle] = useState(job.title);
  const [description, setDescription] = useState(job.description);
  const [priority, setPriority] = useState(job.priority);
  return (
    <div className="grid min-w-0 gap-3">
      <label className={`${labelClass} min-w-0`}>
        <span>Title</span>
        <input name="title" required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} className={inputClass} />
      </label>
      <label className={`${labelClass} min-w-0`}>
        <span>Description</span>
        <textarea name="description" maxLength={2000} rows={4} value={description} onChange={(e) => setDescription(e.target.value)} className={textareaClass} />
      </label>
      <label className={`${labelClass} min-w-0`}>
        <span>Priority</span>
        <select name="priority" value={priority} onChange={(e) => setPriority(e.target.value)} className={inputClass}>
          {priorities.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

export function AssignForm({
  job,
  technicians,
  techError,
}: {
  job: Ids;
  technicians: { id: string; name: string }[];
  techError: string | null;
}) {
  const [assigneeId, setAssigneeId] = useState("");
  const [state, action, pending] = useSavedForm(updateJobAction, { prepare: prepareWindow });
  if (techError) {
    return (
      <p role="alert" className="text-sm font-medium text-danger">
        {techError}
      </p>
    );
  }
  return (
    <form action={action} aria-busy={pending} className="min-w-0 space-y-3">
      <HiddenJob job={job} />
      <input type="hidden" name="op" value="assign" />
      <label className={`${labelClass} min-w-0`}>
        <span>Technician</span>
        <select name="assigneeId" required value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} className={inputClass} disabled={technicians.length === 0}>
          <option value="">{technicians.length === 0 ? "No technicians yet" : "Choose a technician"}</option>
          {technicians.map((tech) => (
            <option key={tech.id} value={tech.id}>
              {tech.name}
            </option>
          ))}
        </select>
      </label>
      <p className="text-sm text-muted">Leave the window blank to keep the current one. A job with no window needs both times, at most 12 hours apart. Choosing a different technician sets the job back to scheduled.</p>
      <WindowFields idPrefix={`assign-${job.id}`} startIso={null} endIso={null} />
      <FormError message={state.error} />
      <button type="submit" disabled={pending || technicians.length === 0} className={`${buttonPrimary} w-full sm:w-auto`}>
        {pending ? "Saving…" : "Assign"}
      </button>
    </form>
  );
}

export function UnassignForm({ job }: { job: Ids }) {
  const [state, action, pending] = useSavedForm(updateJobAction);
  return (
    <form action={action} aria-busy={pending} className="min-w-0 space-y-3">
      <HiddenJob job={job} />
      <input type="hidden" name="op" value="unassign" />
      <FormError message={state.error} />
      <button type="submit" disabled={pending} className={`${buttonSecondary} w-full sm:w-auto`}>
        {pending ? "Removing…" : "Remove the technician"}
      </button>
    </form>
  );
}

function subscribeClock() {
  return () => {};
}

/** Empty during server render so the markup matches, then the device's local time. */
function useDeviceLocal(iso: string | null): string {
  return useSyncExternalStore(subscribeClock, () => toLocalInput(iso), () => "");
}

function WindowFields({ idPrefix, startIso, endIso }: { idPrefix: string; startIso: string | null; endIso: string | null }) {
  const deviceStart = useDeviceLocal(startIso);
  const deviceEnd = useDeviceLocal(endIso);
  const [start, setStart] = useState<string | null>(null);
  const [end, setEnd] = useState<string | null>(null);
  return (
    <div className="grid min-w-0 gap-3 sm:grid-cols-2">
      <label className={`${labelClass} min-w-0`}>
        <span>Start</span>
        <input type="datetime-local" name="scheduledStart" value={start ?? deviceStart} onChange={(e) => setStart(e.target.value)} className={inputClass} aria-describedby={`${idPrefix}-window`} />
      </label>
      <label className={`${labelClass} min-w-0`}>
        <span>End</span>
        <input type="datetime-local" name="scheduledEnd" value={end ?? deviceEnd} onChange={(e) => setEnd(e.target.value)} className={inputClass} aria-describedby={`${idPrefix}-window`} />
      </label>
      <p id={`${idPrefix}-window`} className="text-sm text-muted sm:col-span-2">
        Times use the clock on this device. The window can be at most 12 hours.
      </p>
    </div>
  );
}

export function RescheduleForm({ job }: { job: Ids & { scheduledStart: string | null; scheduledEnd: string | null } }) {
  const [state, action, pending] = useSavedForm(updateJobAction, { prepare: prepareWindow });
  return (
    <form action={action} aria-busy={pending} className="min-w-0 space-y-3">
      <HiddenJob job={job} />
      <input type="hidden" name="op" value="reschedule" />
      <WindowFields key={job.version} idPrefix={`reschedule-${job.id}`} startIso={job.scheduledStart} endIso={job.scheduledEnd} />
      <FormError message={state.error} />
      <button type="submit" disabled={pending} className={`${buttonPrimary} w-full sm:w-auto`}>
        {pending ? "Saving…" : "Save schedule"}
      </button>
    </form>
  );
}

export function StatusForm({
  job,
  actions,
  needsNote,
}: {
  job: Ids;
  actions: { to: string; label: string; needsNote: boolean }[];
  needsNote: boolean;
}) {
  const [state, action, pending] = useSavedForm(updateJobAction);
  if (actions.length === 0) return null;
  return (
    <form action={action} aria-busy={pending} className="min-w-0 space-y-3">
      <HiddenJob job={job} />
      <input type="hidden" name="op" value="status" />
      {needsNote && (
        <p id="status-needs-note" className="text-sm text-muted">
          Add a note about the work before you put the job on hold or mark it completed.
        </p>
      )}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {actions.map((item) => (
          <button
            key={item.to}
            type="submit"
            name="to"
            value={item.to}
            disabled={pending || item.needsNote}
            aria-describedby={item.needsNote ? "status-needs-note" : undefined}
            className={`${buttonPrimary} w-full sm:w-auto`}
          >
            {pending ? "Saving…" : item.label}
          </button>
        ))}
      </div>
      <FormError message={state.error} />
    </form>
  );
}

export function ReopenForm({ job }: { job: Ids }) {
  const [state, action, pending] = useSavedForm(updateJobAction);
  return (
    <form action={action} aria-busy={pending} className="min-w-0 space-y-3">
      <HiddenJob job={job} />
      <input type="hidden" name="op" value="reopen" />
      <FormError message={state.error} />
      <button type="submit" disabled={pending} className={`${buttonSecondary} w-full sm:w-auto`}>
        {pending ? "Reopening…" : "Reopen as scheduled"}
      </button>
    </form>
  );
}

export function CancelForm({ job }: { job: Ids }) {
  const [state, action, pending] = useSavedForm(updateJobAction);
  return (
    <form action={action} aria-busy={pending} className="min-w-0 space-y-3">
      <HiddenJob job={job} />
      <input type="hidden" name="op" value="cancel" />
      <label className="flex min-h-11 items-start gap-3 text-sm">
        <input type="checkbox" name="confirm" required className="mt-1 size-4 accent-accent" />
        <span>Cancel this job. It leaves the schedule.</span>
      </label>
      <FormError message={state.error} />
      <button type="submit" disabled={pending} className={`${buttonDanger} w-full sm:w-auto`}>
        {pending ? "Cancelling…" : "Cancel job"}
      </button>
    </form>
  );
}

export function AddNoteForm({ job }: { job: { id: string; customerId: string } }) {
  const [body, setBody] = useState("");
  const [state, action, pending] = useSavedForm(addNoteAction, {
    opFields: ["body"],
    opName: "opId",
    onOk: () => setBody(""),
  });
  return (
    <form action={action} aria-busy={pending} className="min-w-0 space-y-3">
      <input type="hidden" name="id" value={job.id} />
      <input type="hidden" name="customerId" value={job.customerId} />
      <label className={`${labelClass} min-w-0`}>
        <span>Note</span>
        <textarea name="body" required maxLength={2000} rows={4} value={body} onChange={(e) => setBody(e.target.value)} className={textareaClass} />
      </label>
      <FormError message={state.error} />
      <button type="submit" disabled={pending} className={`${buttonPrimary} w-full sm:w-auto`}>
        {pending ? "Adding…" : "Add note"}
      </button>
    </form>
  );
}

export function WorkOrderDecision({ job }: { job: Ids }) {
  const [reason, setReason] = useState("");
  const [approveState, approveAction, approvePending] = useSavedForm(workOrderAction, {
    opFields: ["op", "version"],
  });
  const [returnState, returnAction, returnPending] = useSavedForm(workOrderAction, {
    opFields: ["op", "version", "reason"],
    onOk: () => setReason(""),
  });
  const pending = approvePending || returnPending;
  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-2">
      <form action={approveAction} aria-busy={approvePending} className="min-w-0 space-y-3">
        <HiddenJob job={job} />
        <input type="hidden" name="op" value="approve" />
        <FormError message={approveState.error} />
        <button type="submit" disabled={pending} className={`${buttonPrimary} w-full`}>
          {approvePending ? "Approving…" : "Approve work order"}
        </button>
      </form>
      <form action={returnAction} aria-busy={returnPending} className="min-w-0 space-y-3">
        <HiddenJob job={job} />
        <input type="hidden" name="op" value="return" />
        <label className={`${labelClass} min-w-0`}>
          <span>What should the technician fix?</span>
          <textarea name="reason" required maxLength={300} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} className={textareaClass} />
        </label>
        <FormError message={returnState.error} />
        <button type="submit" disabled={pending} className={`${buttonSecondary} w-full`}>
          {returnPending ? "Returning…" : "Return to technician"}
        </button>
      </form>
    </div>
  );
}
