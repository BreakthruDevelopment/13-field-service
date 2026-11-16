import { StatusBadge, type Status } from "@/components/ui";
import { JOB_STATUS_LABELS, WORK_ORDER_STATUS_LABELS, type WorkOrderStatus } from "@/lib/field-format";
import type { JobStatus } from "@/lib/job-status";

function jobTone(status: JobStatus): Status {
  if (status === "completed") return "passed";
  if (status === "on_site") return "live";
  if (status === "scheduled" || status === "en_route") return "building";
  if (status === "on_hold") return "blocked";
  return "not-started";
}

function workOrderTone(status: WorkOrderStatus): Status {
  if (status === "approved") return "passed";
  if (status === "returned") return "blocked";
  if (status === "submitted") return "building";
  return "not-started";
}

export function JobStatusBadge({ status }: { status: JobStatus }) {
  return <StatusBadge status={jobTone(status)} label={JOB_STATUS_LABELS[status]} />;
}

export function WorkOrderStatusBadge({ status }: { status: WorkOrderStatus }) {
  return <StatusBadge status={workOrderTone(status)} label={WORK_ORDER_STATUS_LABELS[status]} />;
}
