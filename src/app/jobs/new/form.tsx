"use client";

import { useActionState, useRef } from "react";
import { useRouter } from "next/navigation";
import { buttonPrimary, inputClass, labelClass } from "@/components/ui/styles";
import { type KeyedOp, opFor } from "@/lib/client-op";
import { jobPriorityLabel } from "@/lib/dispatch-view";
import { type JobActionState, createJobAction } from "./actions";

type Customer = { id: string; name: string };
type Site = { id: string; customerId: string; customerName: string; label: string; address: string };
type Technician = { id: string; name: string; email: string };

export function NewJobForm({
  customers,
  sites,
  technicians,
}: {
  customers: Customer[];
  sites: Site[];
  technicians: Technician[];
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const op = useRef<KeyedOp | null>(null);
  const [state, action, pending] = useActionState<JobActionState, FormData>(async (prev, form) => {
    const payload = {
      customerId: form.get("customerId"),
      customerName: form.get("customerName"),
      customerPhone: form.get("customerPhone"),
      customerEmail: form.get("customerEmail"),
      customerNotes: form.get("customerNotes"),
      siteId: form.get("siteId"),
      siteLabel: form.get("siteLabel"),
      siteAddress: form.get("siteAddress"),
      siteAccessNotes: form.get("siteAccessNotes"),
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
      if (result.ok && result.boardDate) {
        op.current = null;
        router.push(`/board?date=${result.boardDate}`);
        router.refresh();
      } else if (!result.error) {
        op.current = null;
      }
      return result;
    } catch {
      return { error: "Couldn't reach the server. Try again." };
    }
  }, {});

  return (
    <form ref={formRef} action={action} className="space-y-8">
      <fieldset className="min-w-0 space-y-3">
        <legend className="font-display text-2xl font-semibold">Customer</legend>
        <p className="text-sm text-muted">Pick someone already on file, or leave this on “New customer” and fill in the fields below.</p>
        <label className={labelClass}>
          <span>Existing customer</span>
          <select name="customerId" defaultValue="" className={inputClass}>
            <option value="">New customer</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className={labelClass}>
          <span>New customer name</span>
          <input name="customerName" maxLength={120} autoComplete="organization" className={`${inputClass} break-words`} />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={labelClass}>
            <span>Phone</span>
            <input name="customerPhone" type="tel" maxLength={40} autoComplete="tel" className={inputClass} />
          </label>
          <label className={labelClass}>
            <span>Email</span>
            <input name="customerEmail" type="email" maxLength={200} autoComplete="email" className={inputClass} />
          </label>
        </div>
        <label className={labelClass}>
          <span>Notes</span>
          <textarea name="customerNotes" rows={2} maxLength={1000} className={inputClass} />
        </label>
      </fieldset>

      <fieldset className="min-w-0 space-y-3">
        <legend className="font-display text-2xl font-semibold">Site</legend>
        <p className="text-sm text-muted">Pick a site for the customer above, or describe a new one. A new customer needs a new site.</p>
        <label className={labelClass}>
          <span>Existing site</span>
          <select name="siteId" defaultValue="" className={inputClass}>
            <option value="">New site</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.customerName} — {s.label}
              </option>
            ))}
          </select>
        </label>
        <label className={labelClass}>
          <span>Site label</span>
          <input name="siteLabel" maxLength={80} className={inputClass} />
        </label>
        <label className={labelClass}>
          <span>Address</span>
          <input name="siteAddress" maxLength={300} autoComplete="street-address" className={inputClass} />
        </label>
        <label className={labelClass}>
          <span>Access notes</span>
          <textarea name="siteAccessNotes" rows={2} maxLength={500} className={inputClass} />
        </label>
      </fieldset>

      <fieldset className="min-w-0 space-y-3">
        <legend className="font-display text-2xl font-semibold">Job</legend>
        <label className={labelClass}>
          <span>Title</span>
          <input name="title" required maxLength={120} className={inputClass} />
        </label>
        <label className={labelClass}>
          <span>Description</span>
          <textarea name="description" rows={3} maxLength={2000} className={inputClass} />
        </label>
        <label className={labelClass}>
          <span>Priority</span>
          <select name="priority" defaultValue="normal" className={inputClass}>
            {(["low", "normal", "high", "emergency"] as const).map((priority) => (
              <option key={priority} value={priority}>
                {jobPriorityLabel(priority)}
              </option>
            ))}
          </select>
        </label>
      </fieldset>

      <fieldset className="min-w-0 space-y-3">
        <legend className="font-display text-2xl font-semibold">Assign</legend>
        <p className="text-sm text-muted">Optional. To put it on the board, choose a technician and a window of 12 hours or less. Times are UTC.</p>
        <label className={labelClass}>
          <span>Technician</span>
          <select name="assigneeId" defaultValue="" className={inputClass}>
            <option value="">Leave unassigned</option>
            {technicians.map((tech) => (
              <option key={tech.id} value={tech.id}>
                {tech.name} · {tech.email}
              </option>
            ))}
          </select>
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={labelClass}>
            <span>Start (UTC)</span>
            <input name="scheduledStart" type="datetime-local" className={inputClass} />
          </label>
          <label className={labelClass}>
            <span>End (UTC)</span>
            <input name="scheduledEnd" type="datetime-local" className={inputClass} />
          </label>
        </div>
      </fieldset>

      {state.error && (
        <p role="alert" className="text-sm font-medium text-danger">
          {state.error}
        </p>
      )}
      <button type="submit" disabled={pending} className={buttonPrimary}>
        {pending ? "Saving…" : "Create job"}
      </button>
    </form>
  );
}
