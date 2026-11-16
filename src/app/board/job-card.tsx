import Link from "next/link";
import { JobPriorityBadge, JobStatusBadge } from "@/components/job-status-badge";
import { type JobPriority, formatWindow, isoToZonedLocal } from "@/lib/job-display";
import type { JobSummary } from "@/lib/service-jobs";
import { AssignForm } from "./assign-form";

export function JobCard({
  job,
  tz,
  date,
  technicians,
  assignable,
}: {
  job: JobSummary;
  tz: string;
  date: string;
  technicians: { id: string; name: string }[];
  assignable: boolean;
}) {
  const defaultStart = (job.scheduledStart && isoToZonedLocal(job.scheduledStart, tz)) || `${date}T09:00`;
  const defaultEnd = (job.scheduledEnd && isoToZonedLocal(job.scheduledEnd, tz)) || `${date}T10:00`;
  return (
    <article className="min-w-0 space-y-2 rounded-card border border-border bg-background p-3">
      <h3 className="min-w-0 font-semibold [overflow-wrap:anywhere]">
        <Link href={`/jobs/${job.id}`} className="text-accent hover:underline">
          <span className="font-mono">#{job.number}</span> {job.title}
        </Link>
      </h3>
      <p className="min-w-0 text-sm [overflow-wrap:anywhere]">{job.customer.name}</p>
      <p className="min-w-0 text-sm text-muted [overflow-wrap:anywhere]">{job.site.address}</p>
      <p className="text-sm">{formatWindow(job.scheduledStart, job.scheduledEnd, tz)}</p>
      <div className="flex flex-wrap gap-2">
        <JobStatusBadge status={job.status} />
        <JobPriorityBadge priority={job.priority as JobPriority} />
      </div>
      {assignable && (
        <AssignForm
          jobId={job.id}
          version={job.version}
          technicians={technicians}
          defaultStart={defaultStart}
          defaultEnd={defaultEnd}
          tz={tz}
        />
      )}
    </article>
  );
}
