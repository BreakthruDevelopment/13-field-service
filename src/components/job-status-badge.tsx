import { StatusBadge } from "@/components/ui";
import {
  JOB_PRIORITY_LABELS,
  JOB_STATUS_LABELS,
  type JobPriority,
  jobPriorityTone,
  jobStatusTone,
} from "@/lib/job-display";
import type { JobStatus } from "@/lib/job-status";

export function JobStatusBadge({ status }: { status: JobStatus }) {
  return <StatusBadge status={jobStatusTone(status)} label={JOB_STATUS_LABELS[status]} />;
}

export function JobPriorityBadge({ priority }: { priority: JobPriority }) {
  return <StatusBadge status={jobPriorityTone(priority)} label={JOB_PRIORITY_LABELS[priority]} />;
}
