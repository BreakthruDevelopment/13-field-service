"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { PageIntro, Panel, StatusBadge, buttonSecondary } from "@/components/ui";
import { runAsyncAction } from "@/lib/client-op";
import type { AttentionItem, TechJob } from "@/lib/offline/types";
import { useAsyncAction } from "@/lib/use-async-action";
import { useTechData } from "@/lib/offline/use-tech-data";
import { TechJobView } from "./tech-job";
import {
  GROUP_META,
  attentionDetail,
  attentionHeading,
  attentionNoteBody,
  attentionServerStatus,
  changeCount,
  formatClock,
  formatWindow,
  groupJobs,
  jobStatusBadge,
  priorityBadge,
  priorityLabel,
  syncChip,
  userTextClass,
} from "./present";

function useOnline(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener("online", onChange);
      window.addEventListener("offline", onChange);
      return () => {
        window.removeEventListener("online", onChange);
        window.removeEventListener("offline", onChange);
      };
    },
    () => navigator.onLine,
    () => true,
  );
}

/** The service worker sets this once the shell and the files this page loaded are saved. */
function useOfflineReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const sync = () => setReady(document.documentElement.dataset.offlineReady === "1");
    const onEvent = (event: Event) => setReady(Boolean((event as CustomEvent<{ ready?: boolean }>).detail?.ready));
    sync();
    window.addEventListener("fsd:offline-ready", onEvent);
    return () => window.removeEventListener("fsd:offline-ready", onEvent);
  }, []);
  return ready;
}

function useJobQuery(): { jobId: string | null; open: (id: string) => void; close: () => void } {
  const [jobId, setJobId] = useState<string | null>(null);
  useEffect(() => {
    const read = () => {
      const id = new URLSearchParams(window.location.search).get("job");
      setJobId(id && id.trim() ? id : null);
    };
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);
  const open = useCallback((id: string) => {
    window.history.pushState({ techJob: id }, "", `/tech?job=${encodeURIComponent(id)}`);
    setJobId(id);
  }, []);
  const close = useCallback(() => {
    const state = window.history.state as { techJob?: string } | null;
    if (state && typeof state === "object" && state.techJob) {
      window.history.back();
      return;
    }
    window.history.pushState(null, "", "/tech");
    setJobId(null);
  }, []);
  return { jobId, open, close };
}

function AttentionList({ items, ready }: { items: AttentionItem[]; ready: boolean }) {
  const data = useTechData();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);

  async function dismiss(opId: string) {
    if (pendingId) return;
    await runAsyncAction(
      () => data.dismissAttention(opId),
      { setPending: (pending) => setPendingId(pending ? opId : null), setError },
      "Couldn't dismiss that. Try again.",
    );
  }

  async function copy(opId: string, body: string) {
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(body);
      setCopiedId(opId);
    } catch {
      setCopiedId(null);
      setCopyError("Couldn't copy automatically. Select the note and copy it.");
    }
  }

  return (
    <Panel title="Needs attention" count={items.length}>
      {items.length === 0 ? (
        ready ? <p className="text-sm text-muted">Nothing needs attention.</p> : <p className="text-sm text-muted">Checking this phone…</p>
      ) : (
        <ul className="space-y-3">
          {items.map((item) => {
            const note = attentionNoteBody(item);
            const server = attentionServerStatus(item);
            return (
              <li key={item.opId} className="min-w-0 rounded-card border border-border p-3">
                <p className={`font-medium ${userTextClass}`}>{attentionHeading(item)}</p>
                <p className={`mt-1 text-sm text-muted ${userTextClass}`}>{attentionDetail(item)}</p>
                {server && <p className="mt-1 text-sm text-muted">{server}</p>}
                {note !== null && (
                  <p className={`mt-2 rounded-card bg-background px-3 py-2 text-sm ${userTextClass}`}>{note}</p>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  {note !== null && (
                    <button type="button" className={buttonSecondary} onClick={() => void copy(item.opId, note)}>
                      {copiedId === item.opId ? "Copied" : "Copy note"}
                    </button>
                  )}
                  <button type="button" className={buttonSecondary} disabled={pendingId === item.opId} onClick={() => void dismiss(item.opId)}>
                    {pendingId === item.opId ? "Dismissing…" : "Dismiss"}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm font-medium text-danger">
          {error}
        </p>
      )}
      {copyError && (
        <p role="alert" className="mt-3 text-sm font-medium text-danger">
          {copyError}
        </p>
      )}
    </Panel>
  );
}

function JobCard({ job, onOpen }: { job: TechJob; onOpen: (id: string) => void }) {
  const status = jobStatusBadge(job.status);
  const priority = priorityBadge(job.priority);
  return (
    <li className="min-w-0">
      <a
        href={`/tech?job=${encodeURIComponent(job.id)}`}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
          event.preventDefault();
          onOpen(job.id);
        }}
        className="block min-w-0 rounded-card border border-border bg-background p-4 hover:border-accent"
      >
        <span className="flex flex-wrap items-center gap-2">
          <StatusBadge status={status.status} label={status.label} />
          {priority ? <StatusBadge status={priority.status} label={priority.label} /> : <span className="text-sm text-muted">{priorityLabel(job.priority)}</span>}
          <span className="font-mono text-sm text-muted">#{job.number}</span>
        </span>
        <span className={`mt-2 block text-lg font-semibold ${userTextClass}`}>{job.title}</span>
        <span className={`mt-1 block text-sm ${userTextClass}`}>{job.customer.name}</span>
        <span className={`block text-sm text-muted ${userTextClass}`}>{job.site.address}</span>
        <span className="mt-1 block text-sm text-muted">{formatWindow(job.scheduledStart, job.scheduledEnd)}</span>
        {job.pendingOps ? <span className="mt-1 block text-sm text-building">{changeCount(job.pendingOps)} waiting to sync</span> : null}
      </a>
    </li>
  );
}

function JobList({ jobs, onOpen }: { jobs: TechJob[]; onOpen: (id: string) => void }) {
  const groups = groupJobs(jobs, new Date());
  return (
    <div className="min-w-0">
      {jobs.length === 0 && <p className="mb-6 text-muted">No jobs on this phone yet. Assigned jobs show up here when you are online.</p>}
      {GROUP_META.map((group) => (
        <Panel key={group.id} title={group.title} count={groups[group.id].length}>
          {groups[group.id].length === 0 ? (
            <p className="text-sm text-muted">{group.empty}</p>
          ) : (
            <ul className="grid min-w-0 gap-3">
              {groups[group.id].map((job) => (
                <JobCard key={job.id} job={job} onOpen={onOpen} />
              ))}
            </ul>
          )}
        </Panel>
      ))}
    </div>
  );
}

export function TechHome({ units }: { units: readonly string[] }) {
  const data = useTechData();
  const online = useOnline();
  const offlineReady = useOfflineReady();
  const { jobId, open, close } = useJobQuery();
  const job = jobId ? data.jobs.find((item) => item.id === jobId) : undefined;
  const chip = syncChip({ ready: data.ready, online, status: data.status, pending: data.pending });
  const syncNow = useAsyncAction(async () => {
    await data.flush();
  }, "Couldn't sync. Try again.");
  const canSync = data.ready && online && data.pending > 0 && data.status !== "signed_out" && data.status !== "forbidden" && data.status !== "wiped";

  return (
    <div className="min-w-0">
      {jobId && (
        <a href="/tech" onClick={(event) => { event.preventDefault(); close(); }} className="mb-4 inline-flex min-h-11 items-center text-sm font-semibold text-accent">
          ← My jobs
        </a>
      )}
      <PageIntro
        section="My jobs"
        title={job ? job.title : "My jobs"}
        description={job ? undefined : "Notes, status and check-ins stay on this phone when you have no signal."}
        actions={
          <>
            <StatusBadge status={chip.tone} label={chip.label} />
            {offlineReady && <StatusBadge status="live" label="Available offline" />}
            {canSync && (
              <button type="button" className={buttonSecondary} disabled={syncNow.pending} onClick={() => void syncNow.run()}>
                {syncNow.pending ? "Syncing…" : "Sync now"}
              </button>
            )}
          </>
        }
      />
      <div aria-live="polite" className="sr-only">
        {chip.label}
      </div>
      {!online && (
        <p role="status" className="mb-6 rounded-card border border-border bg-building-soft px-4 py-3 text-sm text-building">
          {"You're offline. Notes and check-ins stay on this phone and sync when you reconnect."}
          {data.pending > 0 ? ` ${changeCount(data.pending)} waiting.` : ""}
        </p>
      )}
      {online && data.status === "signed_out" && (
        <p role="alert" className="mb-6 rounded-card border border-border bg-blocked-soft px-4 py-3 text-sm text-blocked">
          Sign in again to sync. Changes on this phone are kept until then.
        </p>
      )}
      {online && data.status === "forbidden" && (
        <p role="alert" className="mb-6 rounded-card border border-border bg-blocked-soft px-4 py-3 text-sm text-blocked">
          {"This account can't sync. Sign in with the technician who owns these jobs."}
        </p>
      )}
      {syncNow.error && (
        <p role="alert" className="mb-6 text-sm font-medium text-danger">
          {syncNow.error}
        </p>
      )}
      {data.ready && data.lastSyncedAt && online && data.pending === 0 && data.status === "idle" && (
        <p className="-mt-4 mb-6 text-sm text-muted">Last synced {formatClock(data.lastSyncedAt)}.</p>
      )}
      {data.ready && data.truncated && (
        <p className="mb-6 text-sm text-muted">{"Some jobs didn't fit on this phone. Open the app online to refresh."}</p>
      )}
      {(!data.ready || !job || data.attention.length > 0) && <AttentionList items={data.attention} ready={data.ready} />}
      {!data.ready ? (
        <p className="text-muted">Loading your jobs…</p>
      ) : jobId && !job ? (
        <Panel title="Job">
          <p className="text-muted">{"That job isn't on this phone. It may have been reassigned, or it hasn't downloaded yet."}</p>
        </Panel>
      ) : job ? (
        <TechJobView key={job.id} job={job} units={units} online={online} />
      ) : (
        <JobList jobs={data.jobs} onOpen={open} />
      )}
    </div>
  );
}
