"use client";

import { useId, useRef, useState } from "react";
import { Panel, StatusBadge, buttonPrimary, buttonSecondary, inputClass, labelClass } from "@/components/ui";
import { captureCheckInLocation } from "@/lib/offline/geolocation";
import type { CheckInLocation, JobStatus, TechJob } from "@/lib/offline/types";
import { useAsyncAction } from "@/lib/use-async-action";
import { useTechData } from "@/lib/offline/use-tech-data";
import { WorkOrderPanel } from "./work-order-panel";
import {
  formatWindow,
  jobStatusBadge,
  needsNoteFirst,
  openStreetMapUrl,
  phoneError,
  priorityBadge,
  priorityLabel,
  statusButtons,
  userTextClass,
  type StatusButton,
} from "./present";

const NOTE_MAX = 2000;

export function TechJobView({ job, units, online }: { job: TechJob; units: readonly string[]; online: boolean }) {
  const data = useTechData();
  const noteId = useId();
  const countId = useId();
  const hintId = useId();
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [activeTo, setActiveTo] = useState<JobStatus | null>(null);
  const intent = useRef<{ to: JobStatus; checkIn: boolean; fix: Promise<CheckInLocation | null> } | null>(null);
  const statusGate = useRef(false);
  const status = jobStatusBadge(job.status);
  const priority = priorityBadge(job.priority);
  const buttons = statusButtons(job.status);
  const noteRequired = buttons.some((button) => needsNoteFirst(job, button.to));
  const cancelled = job.status === "cancelled";
  const mapUrl = openStreetMapUrl(job.site);
  const serverNotes = job.notes.filter((item) => !item.pending).length;

  const noteAction = useAsyncAction(async () => {
    setNoteError(null);
    try {
      await data.addNote(job.id, note);
      setNote("");
    } catch (err) {
      setNoteError(phoneError(err));
    }
  });

  const statusAction = useAsyncAction(async () => {
    const current = intent.current;
    if (!current) return;
    setStatusError(null);
    setStatusNote(null);
    try {
      const location = await current.fix;
      await data.setStatus(job.id, current.to, { location });
      if (current.checkIn) {
        setStatusNote(
          location
            ? "Checked in. The location is device-reported and syncs with this change."
            : "Checked in without a location. The status still syncs.",
        );
      }
    } catch (err) {
      setStatusError(phoneError(err));
    }
  });

  function clickStatus(button: StatusButton) {
    // A second tap in the same frame is ignored. The location call stays inside this tap, before any await.
    if (statusGate.current) return;
    statusGate.current = true;
    const fix = button.checkIn ? captureCheckInLocation() : Promise.resolve(null);
    intent.current = { to: button.to, checkIn: button.checkIn, fix };
    setActiveTo(button.to);
    void statusAction.run().finally(() => {
      statusGate.current = false;
      setActiveTo(null);
    });
  }

  return (
    <article className="min-w-0 pb-44 sm:pb-0 [&_button]:scroll-mb-48 [&_input]:scroll-mb-48 [&_select]:scroll-mb-48 [&_textarea]:scroll-mb-48 sm:[&_button]:scroll-mb-0 sm:[&_input]:scroll-mb-0 sm:[&_select]:scroll-mb-0 sm:[&_textarea]:scroll-mb-0">
      <div className="mb-6 flex flex-wrap items-center gap-2">
        {/* data-testid: the status the technician sees for this job. scripts/e2e-offline.mjs drives this real screen. */}
        <span data-testid="job-status">
          <StatusBadge status={status.status} label={status.label} />
        </span>
        {priority ? (
          <StatusBadge status={priority.status} label={priority.label} />
        ) : (
          <span className="text-sm text-muted">{priorityLabel(job.priority)} priority</span>
        )}
        <span className="font-mono text-sm text-muted">#{job.number}</span>
        {job.pendingOps ? <span className="text-sm text-building">{job.pendingOps} waiting to sync</span> : null}
      </div>
      <p className="mb-6 text-muted">{formatWindow(job.scheduledStart, job.scheduledEnd)}</p>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:static sm:z-auto sm:mb-6 sm:border-0 sm:bg-transparent sm:px-0 sm:py-0">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-2">
          {noteRequired && (
            <p id={hintId} className="text-sm text-muted">
              Add a note about the work before you complete it or put it on hold.
            </p>
          )}
          {statusError && (
            <p role="alert" className="text-sm font-medium text-danger">
              {statusError}
            </p>
          )}
          {statusNote && (
            <p role="status" className="text-sm text-muted">
              {statusNote}
            </p>
          )}
          {buttons.length === 0 ? (
            <p className="text-sm text-muted">
              {cancelled ? "This job was cancelled." : job.status === "completed" ? "This job is completed." : "No status change is available."}
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
              {buttons.map((button) => {
                const blocked = needsNoteFirst(job, button.to);
                const active = statusAction.pending && activeTo === button.to;
                const primary = button.checkIn || button.to === "completed";
                return (
                  <button
                    key={button.to}
                    type="button"
                    className={`${primary ? buttonPrimary : buttonSecondary} w-full whitespace-normal text-center sm:w-auto`}
                    disabled={statusAction.pending || blocked}
                    aria-describedby={blocked ? hintId : undefined}
                    onClick={() => clickStatus(button)}
                  >
                    {active ? (button.checkIn ? "Checking in…" : "Saving…") : button.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <dl className="mb-6 grid min-w-0 gap-4 sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-sm font-medium text-muted">Customer</dt>
          <dd className={userTextClass}>{job.customer.name}</dd>
        </div>
        {job.customer.phone.trim() && (
          <div className="min-w-0">
            <dt className="text-sm font-medium text-muted">Phone</dt>
            <dd>
              <a href={`tel:${job.customer.phone}`} className={`text-accent ${userTextClass}`}>
                {job.customer.phone}
              </a>
            </dd>
          </div>
        )}
        <div className="min-w-0 sm:col-span-2">
          <dt className="text-sm font-medium text-muted">Site</dt>
          <dd className={userTextClass}>
            {job.site.label}
            {job.site.address.trim() ? ` · ${job.site.address}` : ""}
          </dd>
          {mapUrl && (
            <dd className="mt-1">
              <a href={mapUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center text-sm font-semibold text-accent">
                Open in OpenStreetMap <span aria-hidden>↗</span>
              </a>
            </dd>
          )}
        </div>
      </dl>

      {job.description.trim() && (
        <Panel title="Description">
          <p className={userTextClass}>{job.description}</p>
        </Panel>
      )}
      {job.site.accessNotes.trim() && (
        <Panel title="Access notes">
          <p className={userTextClass}>{job.site.accessNotes}</p>
        </Panel>
      )}

      <Panel title="Notes" count={job.notes.length}>
        {job.notesTruncated && <p className="mb-3 text-sm text-muted">{"Older notes aren't on this phone."}</p>}
        {job.notes.length === 0 ? (
          <p className="mb-4 text-sm text-muted">No notes yet.</p>
        ) : (
          <ul data-testid="job-notes" className="mb-4 space-y-3">
            {job.notes.map((item) => (
              <li key={item.id} className="min-w-0 border-b border-border pb-3 last:border-0">
                <p className={userTextClass}>{item.body}</p>
                <p className="mt-1 text-sm text-muted">{item.pending ? "Waiting to sync" : "Saved"}</p>
              </li>
            ))}
          </ul>
        )}
        {cancelled ? (
          <p className="text-sm text-muted">{"This job was cancelled, so notes can't be added."}</p>
        ) : (
          <form
            className="min-w-0 space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void noteAction.run();
            }}
          >
            <label className={`${labelClass} min-w-0`} htmlFor={noteId}>
              Note
            </label>
            <textarea
              id={noteId}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={NOTE_MAX}
              rows={4}
              aria-describedby={countId}
              className={inputClass}
            />
            <p id={countId} className="text-sm text-muted">
              {note.length} / {NOTE_MAX}
            </p>
            {noteError && (
              <p role="alert" className="text-sm font-medium text-danger">
                {noteError}
              </p>
            )}
            <button type="submit" className={buttonPrimary} disabled={noteAction.pending || note.trim().length === 0}>
              {noteAction.pending ? "Adding note…" : "Add note"}
            </button>
          </form>
        )}
      </Panel>

      <WorkOrderPanel
        jobId={job.id}
        jobStatus={job.status}
        serverNoteCount={serverNotes}
        notesTruncated={job.notesTruncated}
        pendingNoteCount={job.notes.length - serverNotes}
        online={online}
        units={units}
      />
    </article>
  );
}
