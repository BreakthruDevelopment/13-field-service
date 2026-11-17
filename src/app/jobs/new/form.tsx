"use client";

import { useActionState, useRef, useState } from "react";
import { unstable_rethrow } from "next/navigation";
import { buttonPrimary, inputClass, labelClass } from "@/components/ui/styles";
import { type KeyedOp, opFor } from "@/lib/client-op";
import { JOB_PRIORITY_LABELS, JOB_PRIORITY_VALUES } from "@/lib/job-display";
import { type NewJobState, createJobAction } from "../actions";

export type SiteOption = { id: string; label: string; address: string };
export type TechnicianOption = { id: string; name: string };

function FormError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-sm font-medium text-danger">
      {message}
    </p>
  );
}

const EMPTY = {
  title: "",
  description: "",
  priority: "normal",
  assigneeId: "",
  scheduledStart: "",
  scheduledEnd: "",
};

export function NewJobForm({
  customerId,
  customerName,
  sites,
  technicians,
  tz,
}: {
  customerId: string;
  customerName: string;
  sites: SiteOption[];
  technicians: TechnicianOption[];
  tz: string;
}) {
  const op = useRef<KeyedOp | null>(null);
  const [vals, setVals] = useState(EMPTY);
  const [siteId, setSiteId] = useState(sites[0]?.id ?? "");
  const set = (key: keyof typeof EMPTY) => (value: string) => setVals((v) => ({ ...v, [key]: value }));

  const [state, action, pending] = useActionState<NewJobState, FormData>(async (prev, form) => {
    const payload = {
      customerId: form.get("customerId"),
      siteId: form.get("siteId"),
      title: form.get("title"),
      description: form.get("description"),
      priority: form.get("priority"),
      assigneeId: form.get("assigneeId"),
      scheduledStart: form.get("scheduledStart"),
      scheduledEnd: form.get("scheduledEnd"),
    };
    op.current = opFor(op.current, payload);
    form.set("clientOpId", op.current.id);
    try {
      const result = await createJobAction(prev, form);
      if (!result.error) op.current = null;
      return result;
    } catch (err) {
      unstable_rethrow(err);
      return { error: "Couldn't reach the server. Try again." };
    }
  }, {});

  const assigning = Boolean(vals.assigneeId);

  return (
    <form action={action} className="min-w-0 space-y-4">
      <input type="hidden" name="customerId" value={customerId} />
      <input type="hidden" name="tz" value={tz} />

      <p className="text-sm text-muted">
        Customer: <span className="font-medium text-foreground [overflow-wrap:anywhere]">{customerName}</span>
      </p>

      <fieldset className="min-w-0 space-y-3">
        <legend className="text-sm font-semibold">Site</legend>
        <label className={`${labelClass} min-w-0`}>
          <span>Site</span>
          <select
            name="siteId"
            required
            value={siteId}
            onChange={(e) => setSiteId(e.target.value)}
            className={inputClass}
          >
            {sites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.label} — {site.address}
              </option>
            ))}
          </select>
        </label>
      </fieldset>

      <fieldset className="min-w-0 space-y-3">
        <legend className="text-sm font-semibold">Details</legend>
        <label className={`${labelClass} min-w-0`}>
          <span>Title</span>
          <input
            name="title"
            required
            maxLength={120}
            value={vals.title}
            onChange={(e) => set("title")(e.target.value)}
            className={`${inputClass} [overflow-wrap:anywhere]`}
          />
        </label>
        <label className={`${labelClass} min-w-0`}>
          <span>Description</span>
          <textarea
            name="description"
            maxLength={2000}
            rows={4}
            value={vals.description}
            onChange={(e) => set("description")(e.target.value)}
            className={`${inputClass} min-h-24 [overflow-wrap:anywhere]`}
          />
        </label>
        <label className={`${labelClass} min-w-0`}>
          <span>Priority</span>
          <select
            name="priority"
            value={vals.priority}
            onChange={(e) => set("priority")(e.target.value)}
            className={inputClass}
          >
            {JOB_PRIORITY_VALUES.map((value) => (
              <option key={value} value={value}>
                {JOB_PRIORITY_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
      </fieldset>

      <fieldset className="min-w-0 space-y-3">
        <legend className="text-sm font-semibold">Assign (optional)</legend>
        <p id="window-hint" className="text-sm font-normal text-muted">
          Leave the technician empty to put the job in the unassigned tray. Assigning needs a start and end, at most 12
          hours apart. Times are {tz}.
        </p>
        <label className={`${labelClass} min-w-0`}>
          <span>Technician</span>
          <select
            name="assigneeId"
            value={vals.assigneeId}
            onChange={(e) => set("assigneeId")(e.target.value)}
            className={inputClass}
          >
            <option value="">Unassigned</option>
            {technicians.map((tech) => (
              <option key={tech.id} value={tech.id}>
                {tech.name}
              </option>
            ))}
          </select>
        </label>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <label className={`${labelClass} min-w-0`}>
            <span>Start</span>
            <input
              type="datetime-local"
              name="scheduledStart"
              required={assigning}
              value={vals.scheduledStart}
              onChange={(e) => set("scheduledStart")(e.target.value)}
              className={inputClass}
              aria-describedby="window-hint"
            />
          </label>
          <label className={`${labelClass} min-w-0`}>
            <span>End</span>
            <input
              type="datetime-local"
              name="scheduledEnd"
              required={assigning}
              value={vals.scheduledEnd}
              onChange={(e) => set("scheduledEnd")(e.target.value)}
              className={inputClass}
            />
          </label>
        </div>
      </fieldset>

      <FormError message={state.error} />
      <button type="submit" disabled={pending} className={`${buttonPrimary} w-full sm:w-auto`}>
        {pending ? "Creating…" : "Create job"}
      </button>
    </form>
  );
}
