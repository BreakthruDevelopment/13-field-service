import { JOB_STATUS_LABELS } from "@/lib/job-display";
import type { JobStatus } from "@/lib/job-status";

/**
 * Labels and the check-in sentence the dispatcher job page shows.
 * Check-in copy follows the geolocation decision: "Checked in ±25 m, 140 m from site",
 * always marked device-reported. No map tiles — only an OpenStreetMap link.
 *
 * Job status and priority labels live in `job-display.ts`, which the board and the jobs list already use.
 */

export const WORK_ORDER_STATUS_LABELS = {
  draft: "Draft",
  submitted: "Submitted",
  approved: "Approved",
  returned: "Returned",
} as const;

export type WorkOrderStatus = keyof typeof WORK_ORDER_STATUS_LABELS;

export const LINE_FLAG_LABELS = {
  unknown_part: "Not in the catalog",
  unit_mismatch: "Unit doesn't match the catalog",
  non_integer: "Quantity isn't a whole number",
  qty_check: "Quantity is unusually high",
} as const;

export const SAFETY_LABELS = {
  gas: "Gas",
  carbon_monoxide: "Carbon monoxide",
  live_wire: "Live wire",
  asbestos: "Asbestos",
  flooding_near_electrics: "Water near electrics",
} as const;

const UNIT_LABELS: Record<string, string> = {
  each: "each",
  ft: "ft",
  m: "m",
  box: "box",
  roll: "roll",
  l: "l",
  kg: "kg",
  set: "set",
};

export function unitLabel(unit: string): string {
  return UNIT_LABELS[unit] ?? unit;
}

export function lineFlagLabel(flag: string): string {
  return flag in LINE_FLAG_LABELS ? LINE_FLAG_LABELS[flag as keyof typeof LINE_FLAG_LABELS] : flag;
}

export function safetyLabel(code: string): string {
  return code in SAFETY_LABELS ? SAFETY_LABELS[code as keyof typeof SAFETY_LABELS] : code;
}

export function statusActionLabel(to: JobStatus): string {
  switch (to) {
    case "en_route":
      return "Mark en route";
    case "on_site":
      return "Mark on site";
    case "on_hold":
      return "Put on hold";
    case "completed":
      return "Mark completed";
    default:
      return JOB_STATUS_LABELS[to];
  }
}

/** The sentence next to a check-in. Distance is omitted when the site has no coordinates. */
export function formatCheckIn(checkIn: {
  accuracyM: number | null;
  distanceFromSiteM: number | null;
  late: boolean;
}): string {
  const accuracy = checkIn.accuracyM;
  const distance = checkIn.distanceFromSiteM;
  let lead = "Checked in";
  if (accuracy !== null && distance !== null) lead = `Checked in ±${accuracy} m, ${distance} m from site`;
  else if (accuracy !== null) lead = `Checked in ±${accuracy} m`;
  else if (distance !== null) lead = `Checked in, ${distance} m from site`;
  const late = checkIn.late ? " The device time was more than 10 minutes old." : "";
  return `${lead}. Device-reported.${late}`;
}

/** A link to the point on OpenStreetMap. Returns null for a coordinate that is not a real position. */
export function osmHref(lat: number, lng: number): string | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`;
}

export function eventSummary(event: {
  kind: string;
  fromStatus: JobStatus | null;
  toStatus: JobStatus | null;
}): string {
  const to = event.toStatus ? JOB_STATUS_LABELS[event.toStatus] : null;
  const from = event.fromStatus ? JOB_STATUS_LABELS[event.fromStatus] : null;
  switch (event.kind) {
    case "created":
      return "Job created";
    case "assigned":
      return to ? `Technician assigned · ${to}` : "Technician assigned";
    case "unassigned":
      return "Technician removed · Unassigned";
    case "rescheduled":
      return "Schedule changed";
    case "status":
      if (from && to) return `Status changed from ${from} to ${to}`;
      if (to) return `Status changed to ${to}`;
      return "Status changed";
    default:
      return "Update";
  }
}

/** A fixed UTC rendering so server HTML and the first client paint match. */
export function formatUtc(iso: string | null): string {
  if (!iso) return "Not scheduled";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Not scheduled";
  return `${new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(date)} UTC`;
}

export function formatQty(qty: number): string {
  if (!Number.isFinite(qty)) return "";
  return Number.isInteger(qty) ? String(qty) : String(Math.round(qty * 100) / 100);
}
