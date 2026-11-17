import { StatusBadge, type Status } from "@/components/ui";
import { WORK_ORDER_STATUS_LABELS, type WorkOrderStatus } from "@/lib/field-format";
import {
  JOB_PRIORITY_LABELS,
  JOB_STATUS_LABELS,
  type JobPriority,
  jobPriorityTone,
  jobStatusTone,
} from "@/lib/job-display";
import type { JobStatus } from "@/lib/job-status";

function workOrderTone(status: WorkOrderStatus): Status {
  if (status === "approved") return "passed";
  if (status === "returned") return "blocked";
  if (status === "submitted") return "building";
  return "not-started";
}

export function JobStatusBadge({ status }: { status: JobStatus }) {
  return <StatusBadge status={jobStatusTone(status)} label={JOB_STATUS_LABELS[status]} />;
}

export function JobPriorityBadge({ priority }: { priority: JobPriority }) {
  return <StatusBadge status={jobPriorityTone(priority)} label={JOB_PRIORITY_LABELS[priority]} />;
}

export function WorkOrderStatusBadge({ status }: { status: WorkOrderStatus }) {
  return <StatusBadge status={workOrderTone(status)} label={WORK_ORDER_STATUS_LABELS[status]} />;
}
