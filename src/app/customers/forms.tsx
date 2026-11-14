"use client";

import { useActionState, useRef } from "react";
import { useRouter } from "next/navigation";
import { buttonPrimary, inputClass, labelClass } from "@/components/ui/styles";
import { type ActionState } from "@/lib/action-error";
import { type KeyedOp, opFor } from "@/lib/client-op";
import { createCustomerAction, createSiteAction, updateCustomerAction, updateSiteAction } from "./actions";

function FormError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-sm font-medium text-danger">
      {message}
    </p>
  );
}

function useOfficeForm(action: (prev: ActionState, form: FormData) => Promise<ActionState>, fields: string[], onOk?: (state: ActionState) => void) {
  const op = useRef<KeyedOp | null>(null);
  return useActionState<ActionState, FormData>(async (prev, form) => {
    const payload: Record<string, FormDataEntryValue | null> = {};
    for (const field of fields) payload[field] = form.get(field);
    op.current = opFor(op.current, payload);
    form.set("clientOpId", op.current.id);
    try {
      const result = await action(prev, form);
      if (result.ok) {
        op.current = null;
        onOk?.(result);
      }
      return result;
    } catch {
      return { error: "Couldn't reach the server. Try again." };
    }
  }, {});
}

export function CreateCustomerForm() {
  const router = useRouter();
  const [state, action, pending] = useOfficeForm(
    createCustomerAction,
    ["name", "phone", "email", "notes"],
    (result) => {
      if (result.id) router.push(`/customers/${result.id}`);
      router.refresh();
    },
  );
  return (
    <form action={action} className="min-w-0 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={labelClass}>
          <span>Name</span>
          <input name="name" required maxLength={120} autoComplete="organization" className={inputClass} />
        </label>
        <label className={labelClass}>
          <span>Phone</span>
          <input name="phone" type="tel" maxLength={40} autoComplete="tel" className={inputClass} />
        </label>
        <label className={labelClass}>
          <span>Email</span>
          <input name="email" type="email" maxLength={200} autoComplete="email" className={inputClass} />
        </label>
      </div>
      <label className={labelClass}>
        <span>Notes</span>
        <textarea name="notes" rows={2} maxLength={1000} className={inputClass} />
      </label>
      <FormError message={state.error} />
      <button type="submit" disabled={pending} className={buttonPrimary}>
        {pending ? "Saving…" : "Add customer"}
      </button>
    </form>
  );
}

export function EditCustomerForm({
  customer,
}: {
  customer: { id: string; version: number; name: string; phone: string; email: string | null; notes: string };
}) {
  const router = useRouter();
  const [state, action, pending] = useActionState<ActionState, FormData>(async (prev, form) => {
    try {
      const result = await updateCustomerAction(prev, form);
      if (result.ok) router.refresh();
      return result;
    } catch {
      return { error: "Couldn't reach the server. Try again." };
    }
  }, {});
  return (
    <form action={action} className="min-w-0 space-y-3">
      <input type="hidden" name="id" value={customer.id} />
      <input type="hidden" name="version" value={customer.version} />
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={labelClass}>
          <span>Name</span>
          <input name="name" required maxLength={120} defaultValue={customer.name} autoComplete="organization" className={inputClass} />
        </label>
        <label className={labelClass}>
          <span>Phone</span>
          <input name="phone" type="tel" maxLength={40} defaultValue={customer.phone} autoComplete="tel" className={inputClass} />
        </label>
        <label className={labelClass}>
          <span>Email</span>
          <input name="email" type="email" maxLength={200} defaultValue={customer.email ?? ""} autoComplete="email" className={inputClass} />
        </label>
      </div>
      <label className={labelClass}>
        <span>Notes</span>
        <textarea name="notes" rows={3} maxLength={1000} defaultValue={customer.notes} className={inputClass} />
      </label>
      <FormError message={state.error} />
      <button type="submit" disabled={pending} className={buttonPrimary}>
        {pending ? "Saving…" : "Save customer"}
      </button>
    </form>
  );
}

function SiteFields({
  site,
}: {
  site?: { label: string; address: string; accessNotes: string; lat: string | null; lng: string | null };
}) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={labelClass}>
          <span>Label</span>
          <input name="label" required maxLength={80} defaultValue={site?.label} className={inputClass} />
        </label>
        <label className={labelClass}>
          <span>Address</span>
          <input name="address" required maxLength={300} defaultValue={site?.address} autoComplete="street-address" className={inputClass} />
        </label>
      </div>
      <label className={labelClass}>
        <span>Access notes</span>
        <textarea name="accessNotes" rows={2} maxLength={500} defaultValue={site?.accessNotes} className={inputClass} />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={labelClass}>
          <span>Latitude</span>
          <input name="lat" inputMode="decimal" maxLength={20} defaultValue={site?.lat ?? ""} placeholder="30.2672" className={inputClass} />
        </label>
        <label className={labelClass}>
          <span>Longitude</span>
          <input name="lng" inputMode="decimal" maxLength={20} defaultValue={site?.lng ?? ""} placeholder="-97.7431" className={inputClass} />
        </label>
      </div>
    </>
  );
}

export function CreateSiteForm({ customerId }: { customerId: string }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useOfficeForm(
    createSiteAction,
    ["label", "address", "accessNotes", "lat", "lng"],
    () => {
      formRef.current?.reset();
      router.refresh();
    },
  );
  return (
    <form ref={formRef} action={action} className="min-w-0 space-y-3">
      <input type="hidden" name="customerId" value={customerId} />
      <SiteFields />
      <FormError message={state.error} />
      <button type="submit" disabled={pending} className={buttonPrimary}>
        {pending ? "Saving…" : "Add site"}
      </button>
    </form>
  );
}

export function EditSiteForm({
  site,
}: {
  site: { id: string; version: number; label: string; address: string; accessNotes: string; lat: string | null; lng: string | null };
}) {
  const router = useRouter();
  const [state, action, pending] = useActionState<ActionState, FormData>(async (prev, form) => {
    try {
      const result = await updateSiteAction(prev, form);
      if (result.ok) router.refresh();
      return result;
    } catch {
      return { error: "Couldn't reach the server. Try again." };
    }
  }, {});
  return (
    <form action={action} className="min-w-0 space-y-3">
      <input type="hidden" name="id" value={site.id} />
      <input type="hidden" name="version" value={site.version} />
      <SiteFields site={site} />
      <FormError message={state.error} />
      <button type="submit" disabled={pending} className={buttonPrimary}>
        {pending ? "Saving…" : "Save site"}
      </button>
    </form>
  );
}
