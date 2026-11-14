import { StatusBadge } from "@/components/ui";
import { formatWindow, jobPriorityLabel, jobStatusLabel, jobStatusTone } from "@/lib/dispatch-view";
import type { DispatchJob } from "@/lib/dispatch";

/** One job on the schedule board. Long unbroken text wraps inside the card. */
export function JobCard({ job }: { job: DispatchJob }) {
  return (
    <article className="min-w-0 rounded-card border border-border bg-background p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="min-w-0 font-semibold break-words">
          <span className="mr-2 font-mono text-sm font-medium text-muted">#{job.number}</span>
          {job.title}
        </h3>
        <StatusBadge status={jobStatusTone(job.status)} label={jobStatusLabel(job.status)} />
      </div>
      <p className="mt-2 text-sm break-words">{job.customerName}</p>
      <p className="text-sm text-muted break-words">
        {job.siteLabel} · {job.siteAddress}
      </p>
      <p className="mt-2 font-mono text-xs text-muted break-words">{formatWindow(job.scheduledStart, job.scheduledEnd)}</p>
      <p className="text-sm">{jobPriorityLabel(job.priority)} priority</p>
    </article>
  );
}
