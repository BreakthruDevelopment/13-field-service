"use client";

import { useEffect, useState } from "react";
import { Panel, StatusBadge } from "@/components/ui";
import { buttonPrimary, buttonSecondary, inputClass, labelClass } from "@/components/ui/styles";
import { runAsyncAction } from "@/lib/client-op";
import { osmUrl } from "@/lib/check-in";
import type { useTechData } from "@/lib/offline/use-tech-data";
import {
  formatWindow,
  PART_UNITS,
  priorityLabel,
  statusActions,
  statusLabel,
  statusTone,
  type TechJob,
  type WorkOrderLineView,
  type WorkOrderTaskView,
  type WorkOrderView,
} from "@/lib/tech-view";

const wrap = "min-w-0 break-words [overflow-wrap:anywhere]";

type TechData = ReturnType<typeof useTechData>;

export function JobScreen({ job, data, onBack }: { job: TechJob; data: TechData; onBack: () => void }) {
  const priority = priorityLabel(job.priority);
  const actions = statusActions(job.status, job.notes.length);
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  const [notePending, setNotePending] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusPending, setStatusPending] = useState<string | null>(null);

  return (
    <article className="min-w-0 pb-36 lg:pb-0">
      <button type="button" className={`${buttonSecondary} mb-4 lg:hidden`} onClick={onBack}>
        All jobs
      </button>
      <header className="mb-4 min-w-0 space-y-2">
        <p className="font-mono text-sm text-muted">#{job.number}</p>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={statusTone(job.status)} label={statusLabel(job.status)} />
          {priority && <span className="text-sm font-medium text-blocked">{priority}</span>}
        </div>
        <h2 className={`font-display text-3xl font-semibold leading-tight ${wrap}`}>{job.title}</h2>
        <p className="text-muted">{formatWindow(job.scheduledStart, job.scheduledEnd)}</p>
      </header>

      <Panel title="Site">
        <p className={`font-semibold ${wrap}`}>{job.customerName}</p>
        {job.customerPhone && (
          <a className={`mt-1 inline-flex min-h-11 items-center text-accent ${wrap}`} href={`tel:${job.customerPhone}`}>
            {job.customerPhone}
          </a>
        )}
        <p className={`mt-2 ${wrap}`}>{job.siteLabel}</p>
        <p className={`text-muted ${wrap}`}>{job.siteAddress}</p>
        {job.accessNotes && <p className={`mt-2 text-sm ${wrap}`}>{job.accessNotes}</p>}
        {job.siteLat != null && job.siteLng != null && (
          <a className="mt-2 inline-flex min-h-11 items-center text-sm font-semibold text-accent" href={osmUrl(job.siteLat, job.siteLng, 5)}>
            Open in OpenStreetMap
          </a>
        )}
        {job.checkIn && (
          <p className={`mt-3 text-sm ${wrap}`}>
            {job.checkIn.summary}. <span className="text-muted">Device-reported.</span>{" "}
            <a className="font-semibold text-accent" href={job.checkIn.osmUrl}>
              Map
            </a>
          </p>
        )}
        {job.description && <p className={`mt-3 text-sm text-muted ${wrap}`}>{job.description}</p>}
      </Panel>

      <div className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-surface p-3 lg:static lg:z-auto lg:mb-6 lg:border-0 lg:bg-transparent lg:p-0">
        <div className="mx-auto grid w-full max-w-6xl gap-2 lg:max-w-none">
          {actions.map((action) => (
            <button
              key={action.to}
              type="button"
              disabled={action.disabled || statusPending !== null}
              className={action.checkIn ? buttonPrimary : buttonSecondary}
              onClick={() =>
                void runAsyncAction(
                  async () => {
                    setStatusPending(action.to);
                    const message = action.checkIn ? await data.checkIn(job.id) : await data.setStatus(job.id, action.to);
                    if (message) setStatusError(message);
                    else setStatusError(null);
                  },
                  { setPending: (pending) => setStatusPending(pending ? action.to : null), setError: setStatusError },
                  "Couldn't update the status.",
                )
              }
            >
              {statusPending === action.to ? "Saving…" : action.label}
            </button>
          ))}
        </div>
        {actions.some((action) => action.reason) && <p className="mt-2 text-sm text-muted">Add a note first.</p>}
        {statusError && (
          <p role="alert" className="mt-2 text-sm font-medium text-danger">
            {statusError}
          </p>
        )}
      </div>

      <Panel title="Notes" count={job.notes.length}>
        {job.notes.length === 0 ? (
          <p className="mb-3 text-sm text-muted">No notes yet.</p>
        ) : (
          <ul className="mb-4 space-y-3">
            {job.notes.map((item) => (
              <li key={item.id} className={`text-sm ${wrap}`}>
                {item.body}
                {item.pending && <span className="ml-2 text-muted">Waiting to sync</span>}
              </li>
            ))}
          </ul>
        )}
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void runAsyncAction(
              async () => {
                const message = await data.addNote(job.id, note);
                if (message) setNoteError(message);
                else {
                  setNote("");
                  setNoteError(null);
                }
              },
              { setPending: setNotePending, setError: setNoteError },
              "Couldn't add that note.",
            );
          }}
        >
          <label className={labelClass}>
            Note
            <textarea
              className={`${inputClass} min-h-24`}
              value={note}
              maxLength={2000}
              onChange={(event) => setNote(event.target.value)}
              required
            />
          </label>
          {noteError && (
            <p role="alert" className="text-sm font-medium text-danger">
              {noteError}
            </p>
          )}
          <button type="submit" className={buttonPrimary} disabled={notePending}>
            {notePending ? "Adding…" : "Add note"}
          </button>
        </form>
      </Panel>

      <WorkOrderEditor jobId={job.id} offline={data.offline} data={data} />
    </article>
  );
}

function WorkOrderEditor({ jobId, offline, data }: { jobId: string; data: TechData; offline: boolean }) {
  const { workOrder, workOrderError, workOrderPending, loadWorkOrder, saveWorkOrder } = data;
  const current = workOrder && workOrder.jobId === jobId ? workOrder : null;

  useEffect(() => {
    if (offline) return;
    void loadWorkOrder(jobId);
  }, [jobId, offline, loadWorkOrder]);

  const locked = offline || current?.status === "submitted" || current?.status === "approved";
  const statusText =
    current?.status === "submitted"
      ? "Submitted. Waiting for the office to approve."
      : current?.status === "approved"
        ? "Approved. This work order is read-only."
        : current?.status === "returned"
          ? "The office sent this back."
          : null;
  const formKey = current ? `${current.jobId}:${current.version}:${current.status}` : `${jobId}:new`;

  return (
    <Panel title="Work order">
      {offline && (
        <p className="mb-3 text-sm text-muted">Work orders need a connection. Notes and status still save on this phone.</p>
      )}
      {statusText && <p className="mb-3 text-sm">{statusText}</p>}
      {current?.returnReason && <p className={`mb-3 text-sm text-blocked ${wrap}`}>{current.returnReason}</p>}
      {workOrderError && (
        <p role="alert" className="mb-3 text-sm font-medium text-danger">
          {workOrderError}
        </p>
      )}
      <WorkOrderForm
        key={formKey}
        workOrder={current}
        locked={locked || workOrderPending}
        pending={workOrderPending}
        hasOrder={current != null}
        onSave={(input) => void saveWorkOrder(jobId, input)}
      />
    </Panel>
  );
}

function WorkOrderForm({
  workOrder,
  locked,
  pending,
  hasOrder,
  onSave,
}: {
  workOrder: WorkOrderView | null;
  locked: boolean;
  pending: boolean;
  hasOrder: boolean;
  onSave: (input: {
    version: number;
    summary: string;
    followUp: string;
    tasks: WorkOrderTaskView[];
    lines: WorkOrderLineView[];
    submit: boolean;
  }) => void;
}) {
  const [summary, setSummary] = useState(workOrder?.summary ?? "");
  const [followUp, setFollowUp] = useState(workOrder?.followUp ?? "");
  const [tasks, setTasks] = useState<WorkOrderTaskView[]>(workOrder?.tasks ?? []);
  const [lines, setLines] = useState<WorkOrderLineView[]>(workOrder?.lines ?? []);

  function payload(submit: boolean) {
    return {
      version: workOrder?.version ?? 1,
      summary: summary.trim(),
      followUp: followUp.trim(),
      tasks: tasks
        .map((task) => ({ ...task, description: task.description.trim() }))
        .filter((task) => task.description.length > 0),
      lines: lines
        .filter((line) => line.mentioned.trim().length > 0)
        .map((line) => ({ ...line, mentioned: line.mentioned.trim() })),
      submit,
    };
  }

  return (
    <>
      <fieldset disabled={locked} className="min-w-0 space-y-4 disabled:opacity-70">
        <label className={labelClass}>
          Summary
          <textarea className={`${inputClass} min-h-24`} value={summary} maxLength={400} onChange={(event) => setSummary(event.target.value)} />
        </label>
        <div className="space-y-2">
          <p className="text-sm font-medium">Tasks</p>
          {tasks.map((task, index) => (
            <div key={index} className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={task.state === "done"}
                  onChange={(event) =>
                    setTasks((current) => current.map((item, i) => (i === index ? { ...item, state: event.target.checked ? "done" : "to_do" } : item)))
                  }
                />
                Done
              </label>
              <input
                aria-label={`Task ${index + 1}`}
                className={`${inputClass} ${wrap}`}
                value={task.description}
                maxLength={200}
                onChange={(event) => setTasks((current) => current.map((item, i) => (i === index ? { ...item, description: event.target.value } : item)))}
              />
              <button type="button" className={buttonSecondary} onClick={() => setTasks((current) => current.filter((_, i) => i !== index))}>
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            className={buttonSecondary}
            disabled={tasks.length >= 12}
            onClick={() => setTasks((current) => [...current, { description: "", state: "to_do" }])}
          >
            Add task
          </button>
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium">Parts</p>
          {lines.map((line, index) => (
            <div key={index} className="grid min-w-0 gap-2 sm:grid-cols-2">
              <label className={labelClass}>
                Part
                <input
                  className={`${inputClass} ${wrap}`}
                  value={line.mentioned}
                  maxLength={120}
                  onChange={(event) => setLines((current) => current.map((item, i) => (i === index ? { ...item, mentioned: event.target.value } : item)))}
                />
              </label>
              <label className={labelClass}>
                Quantity
                <input
                  className={inputClass}
                  inputMode="decimal"
                  value={String(line.qty)}
                  onChange={(event) => {
                    const qty = Number(event.target.value);
                    setLines((current) => current.map((item, i) => (i === index ? { ...item, qty: Number.isFinite(qty) ? qty : item.qty } : item)));
                  }}
                />
              </label>
              <label className={labelClass}>
                Unit
                <select
                  className={inputClass}
                  value={line.unit}
                  onChange={(event) =>
                    setLines((current) => current.map((item, i) => (i === index ? { ...item, unit: event.target.value as WorkOrderLineView["unit"] } : item)))
                  }
                >
                  {PART_UNITS.map((unit) => (
                    <option key={unit} value={unit}>
                      {unit}
                    </option>
                  ))}
                </select>
              </label>
              <label className={labelClass}>
                Used or needed
                <select
                  className={inputClass}
                  value={line.used}
                  onChange={(event) =>
                    setLines((current) => current.map((item, i) => (i === index ? { ...item, used: event.target.value as WorkOrderLineView["used"] } : item)))
                  }
                >
                  <option value="used">Used</option>
                  <option value="needed">Needed</option>
                </select>
              </label>
              <button type="button" className={buttonSecondary} onClick={() => setLines((current) => current.filter((_, i) => i !== index))}>
                Remove part
              </button>
            </div>
          ))}
          <button
            type="button"
            className={buttonSecondary}
            disabled={lines.length >= 30}
            onClick={() => setLines((current) => [...current, { mentioned: "", qty: 1, unit: "each", used: "used" }])}
          >
            Add part
          </button>
        </div>
        <label className={labelClass}>
          Follow-up
          <textarea className={`${inputClass} min-h-20`} value={followUp} maxLength={300} onChange={(event) => setFollowUp(event.target.value)} />
        </label>
      </fieldset>
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" className={buttonSecondary} disabled={locked} onClick={() => onSave(payload(false))}>
          {pending ? "Saving…" : hasOrder ? "Save draft" : "Start draft"}
        </button>
        <button type="button" className={buttonPrimary} disabled={locked || !summary.trim()} onClick={() => onSave(payload(true))}>
          {pending ? "Saving…" : "Submit to the office"}
        </button>
      </div>
    </>
  );
}
