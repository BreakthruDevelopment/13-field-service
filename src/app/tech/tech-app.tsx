"use client";

import { useEffect, useState } from "react";
import { PageIntro, Panel, StatusBadge } from "@/components/ui";
import { buttonSecondary } from "@/components/ui/styles";
import { useTechData } from "@/lib/offline/use-tech-data";
import { formatWindow, priorityLabel, statusLabel, statusTone, type TechJob } from "@/lib/tech-view";
import { JobScreen } from "./job-screen";

const wrap = "min-w-0 break-words [overflow-wrap:anywhere]";

export function TechApp({ userId, initialJobId, buildId }: { userId: string; initialJobId: string | null; buildId: string }) {
  const data = useTechData(userId);
  const [jobId, setJobId] = useState<string | null>(initialJobId);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    // Scope is the origin so the shell can keep the static chunks it needs. The worker itself
    // refuses every page except /tech, and it never stores /api responses.
    navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => undefined);
  }, [buildId]);

  useEffect(() => {
    const fromUrl = () => {
      const value = new URLSearchParams(window.location.search).get("job");
      setJobId(value);
    };
    window.addEventListener("popstate", fromUrl);
    return () => window.removeEventListener("popstate", fromUrl);
  }, []);

  function openJob(id: string) {
    setJobId(id);
    const url = new URL(window.location.href);
    url.searchParams.set("job", id);
    window.history.pushState({}, "", url);
  }

  function closeJob() {
    setJobId(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("job");
    window.history.pushState({}, "", url);
  }

  const selected = jobId ? data.jobs.find((job) => job.id === jobId) : undefined;

  return (
    <div className="min-w-0">
      <PageIntro section="Technician" title="My jobs" description="Assigned to you. Notes and status stay on this phone until they sync." />
      {data.offline && (
        <p role="status" className="mb-4 rounded-card border border-border bg-building-soft px-3 py-3 text-sm text-building">
          You&apos;re offline. Notes and status changes are saved on this phone and sync when you&apos;re back online. Work orders stay locked until then.
        </p>
      )}
      {data.needsSignIn && (
        <p role="alert" className="mb-4 rounded-card border border-border bg-blocked-soft px-3 py-3 text-sm text-blocked">
          Sign in again to sync. Changes already on this phone are kept.
        </p>
      )}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <StatusBadge
          status={data.offline ? "degraded" : data.attention.length > 0 ? "blocked" : data.syncing ? "building" : "live"}
          label={data.syncingLabel}
        />
        {data.error && (
          <button type="button" className={buttonSecondary} onClick={data.retry}>
            Retry
          </button>
        )}
      </div>
      {data.error && (
        <p role="alert" className="mb-4 text-sm font-medium text-danger">
          {data.error}
        </p>
      )}

      <div className={selected ? "lg:grid lg:grid-cols-[18rem_minmax(0,1fr)] lg:items-start lg:gap-6" : ""}>
        <div className={selected ? "hidden min-w-0 lg:block" : "min-w-0"}>
          {!data.ready ? (
            <p className="text-muted">Loading your jobs…</p>
          ) : data.jobs.length === 0 ? (
            <Panel title="Nothing assigned">
              <p className="text-muted">No jobs assigned to you right now. The office adds them to your day.</p>
            </Panel>
          ) : (
            <>
              <JobGroup title="Today" jobs={data.groups.today} onOpen={openJob} />
              <JobGroup title="Upcoming" jobs={data.groups.upcoming} onOpen={openJob} />
              <JobGroup title="Recent" jobs={data.groups.recent} onOpen={openJob} />
            </>
          )}
          <AttentionList items={data.attention} onDismiss={data.dismiss} />
        </div>
        {selected && <JobScreen job={selected} data={data} onBack={closeJob} />}
        {jobId && !selected && data.ready && (
          <Panel title="Job">
            <p className="text-muted">That job isn&apos;t on this phone.</p>
            <button type="button" className={`${buttonSecondary} mt-3`} onClick={closeJob}>
              All jobs
            </button>
          </Panel>
        )}
      </div>
    </div>
  );
}

function JobGroup({ title, jobs, onOpen }: { title: string; jobs: TechJob[]; onOpen: (id: string) => void }) {
  if (jobs.length === 0) return null;
  return (
    <Panel title={title} count={jobs.length}>
      <ul className="space-y-2">
        {jobs.map((job) => {
          const priority = priorityLabel(job.priority);
          return (
            <li key={job.id} className="min-w-0">
              <button
                type="button"
                onClick={() => onOpen(job.id)}
                className="flex min-h-11 w-full min-w-0 flex-col items-start gap-1 rounded-card border border-border px-3 py-3 text-left hover:bg-accent-soft"
              >
                <span className="flex w-full min-w-0 flex-wrap items-center gap-2">
                  <span className="font-mono text-sm text-muted">#{job.number}</span>
                  <StatusBadge status={statusTone(job.status)} label={statusLabel(job.status)} />
                  {priority && <span className="text-sm font-medium text-blocked">{priority}</span>}
                </span>
                <span className={`font-semibold ${wrap}`}>{job.title}</span>
                <span className={`text-sm text-muted ${wrap}`}>{job.customerName}</span>
                <span className="text-sm text-muted">{formatWindow(job.scheduledStart, job.scheduledEnd)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function AttentionList({
  items,
  onDismiss,
}: {
  items: ReturnType<typeof useTechData>["attention"];
  onDismiss: (id: string) => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  if (items.length === 0) return null;
  return (
    <Panel title="Needs attention" count={items.length}>
      <ul className="space-y-4">
        {items.map((item) => (
          <li key={item.id} className="min-w-0 space-y-2 border-b border-border pb-4 last:border-b-0 last:pb-0">
            <p className={`text-sm font-semibold ${wrap}`}>{item.tried}</p>
            <p className={`text-sm text-muted ${wrap}`}>{item.detail}</p>
            {copyError === item.id && (
              <p role="alert" className="text-sm font-medium text-danger">
                Couldn&apos;t copy. Select the note and copy it.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {item.noteBody && (
                <button
                  type="button"
                  className={buttonSecondary}
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(item.noteBody ?? "");
                      setCopied(item.id);
                      setCopyError(null);
                    } catch {
                      setCopyError(item.id);
                    }
                  }}
                >
                  {copied === item.id ? "Copied" : "Copy note"}
                </button>
              )}
              <button type="button" className={buttonSecondary} onClick={() => onDismiss(item.id)}>
                Dismiss
              </button>
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
