"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { buttonDanger, buttonPrimary, buttonSecondary, inputClass, labelClass } from "@/components/ui/styles";
import { type ActionState } from "@/lib/action-error";
import {
  approveWorkOrderAction,
  assignJobAction,
  cancelJobAction,
  reopenJobAction,
  rescheduleJobAction,
  returnWorkOrderAction,
} from "./actions";

function FormError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-sm font-medium text-danger">
      {message}
    </p>
  );
}

function useRefreshAction(action: (prev: ActionState, form: FormData) => Promise<ActionState>) {
  const router = useRouter();
  return useActionState<ActionState, FormData>(async (prev, form) => {
    try {
      const result = await action(prev, form);
      if (result.ok) router.refresh();
      return result;
    } catch {
      return { error: "Couldn't reach the server. Try again." };
    }
  }, {});
}

type Technician = { id: string; name: string; email: string };

export function AssignForm({
  jobId,
  version,
  assigneeId,
  technicians,
  scheduledStart,
  scheduledEnd,
}: {
  jobId: string;
  version: number;
  assigneeId: string | null;
  technicians: Technician[];
  scheduledStart: string;
  scheduledEnd: string;
}) {
  const [state, action, pending] = useRefreshAction(assignJobAction);
  return (
    <form action={action} className="min-w-0 space-y-3">
      <input type="hidden" name="jobId" value={jobId} />
      <input type="hidden" name="version" value={version} />
      <label className={labelClass}>
        <span>Technician</span>
        <select name="assigneeId" defaultValue={assigneeId ?? ""} className={inputClass}>
          <option value="">Unassigned</option>
          {technicians.map((tech) => (
            <option key={tech.id} value={tech.id}>
              {tech.name}
              {tech.email ? ` · ${tech.email}` : ""}
            </option>
          ))}
        </select>
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={labelClass}>
          <span>Start (UTC)</span>
          <input name="scheduledStart" type="datetime-local" defaultValue={scheduledStart} className={inputClass} />
        </label>
        <label className={labelClass}>
          <span>End (UTC)</span>
          <input name="scheduledEnd" type="datetime-local" defaultValue={scheduledEnd} className={inputClass} />
        </label>
      </div>
      <p className="text-sm text-muted">A technician needs a window of 12 hours or less. Times are UTC. Choose Unassigned to take the job off the schedule.</p>
      <FormError message={state.error} />
      <button type="submit" disabled={pending || technicians.length === 0} className={buttonPrimary}>
        {pending ? "Saving…" : "Save assignment"}
      </button>
    </form>
  );
}

export function RescheduleForm({
  jobId,
  version,
  scheduledStart,
  scheduledEnd,
}: {
  jobId: string;
  version: number;
  scheduledStart: string;
  scheduledEnd: string;
}) {
  const [state, action, pending] = useRefreshAction(rescheduleJobAction);
  return (
    <form action={action} className="min-w-0 space-y-3">
      <input type="hidden" name="jobId" value={jobId} />
      <input type="hidden" name="version" value={version} />
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={labelClass}>
          <span>New start (UTC)</span>
          <input name="scheduledStart" type="datetime-local" required defaultValue={scheduledStart} className={inputClass} />
        </label>
        <label className={labelClass}>
          <span>New end (UTC)</span>
          <input name="scheduledEnd" type="datetime-local" required defaultValue={scheduledEnd} className={inputClass} />
        </label>
      </div>
      <FormError message={state.error} />
      <button type="submit" disabled={pending} className={buttonSecondary}>
        {pending ? "Saving…" : "Reschedule"}
      </button>
    </form>
  );
}

export function CancelJobForm({ jobId, version }: { jobId: string; version: number }) {
  const [state, action, pending] = useRefreshAction(cancelJobAction);
  return (
    <form action={action} className="min-w-0 space-y-3">
      <input type="hidden" name="jobId" value={jobId} />
      <input type="hidden" name="version" value={version} />
      <FormError message={state.error} />
      <button type="submit" disabled={pending} className={buttonDanger}>
        {pending ? "Cancelling…" : "Cancel job"}
      </button>
    </form>
  );
}

export function ReopenJobForm({ jobId, version }: { jobId: string; version: number }) {
  const [state, action, pending] = useRefreshAction(reopenJobAction);
  return (
    <form action={action} className="min-w-0 space-y-3">
      <input type="hidden" name="jobId" value={jobId} />
      <input type="hidden" name="version" value={version} />
      <FormError message={state.error} />
      <button type="submit" disabled={pending} className={buttonPrimary}>
        {pending ? "Reopening…" : "Reopen job"}
      </button>
    </form>
  );
}

export function ApproveWorkOrderForm({ jobId, version }: { jobId: string; version: number }) {
  const [state, action, pending] = useRefreshAction(approveWorkOrderAction);
  return (
    <form action={action} className="min-w-0 space-y-3">
      <input type="hidden" name="jobId" value={jobId} />
      <input type="hidden" name="version" value={version} />
      <FormError message={state.error} />
      <button type="submit" disabled={pending} className={buttonPrimary}>
        {pending ? "Approving…" : "Approve work order"}
      </button>
    </form>
  );
}

export function ReturnWorkOrderForm({ jobId, version }: { jobId: string; version: number }) {
  const [state, action, pending] = useRefreshAction(returnWorkOrderAction);
  return (
    <form action={action} className="min-w-0 space-y-3">
      <input type="hidden" name="jobId" value={jobId} />
      <input type="hidden" name="version" value={version} />
      <label className={labelClass}>
        <span>Reason for returning</span>
        <textarea name="reason" required maxLength={300} rows={3} className={inputClass} />
      </label>
      <FormError message={state.error} />
      <button type="submit" disabled={pending} className={buttonSecondary}>
        {pending ? "Returning…" : "Return to technician"}
      </button>
    </form>
  );
}
