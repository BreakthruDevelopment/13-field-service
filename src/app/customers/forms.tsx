"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FormError } from "@/components/form-error";
import { useSavedForm } from "@/components/use-saved-form";
import { buttonPrimary, buttonSecondary, inputClass, labelClass } from "@/components/ui/styles";
import { createCustomerAction, createSiteAction, updateCustomerAction, updateSiteAction } from "./actions";

const textareaClass =
  "min-h-28 w-full rounded-card border border-border-strong bg-surface px-3 py-2 text-base text-foreground placeholder:text-muted focus:border-accent";

type CustomerFields = { id: string; version: number; name: string; phone: string; email: string | null; notes: string };
type SiteFields = {
  id: string;
  version: number;
  label: string;
  address: string;
  accessNotes: string;
  lat: number | null;
  lng: number | null;
};

const EMPTY_SITE = { label: "", address: "", accessNotes: "", lat: "", lng: "" };

function coordText(value: number | null): string {
  return value === null ? "" : String(value);
}

export function AddCustomerForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [state, action, pending] = useSavedForm(createCustomerAction, {
    opFields: ["name", "phone", "email", "notes"],
    onOk: (result) => {
      if (result.id) {
        router.push(`/customers/${result.id}`);
        return "leave";
      }
    },
  });
  return (
    <form action={action} aria-busy={pending} className="min-w-0 space-y-3">
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <label className={`${labelClass} min-w-0`}>
          <span>Name</span>
          <input name="name" required maxLength={120} autoComplete="organization" value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
        </label>
        <label className={`${labelClass} min-w-0`}>
          <span>Phone</span>
          <input name="phone" type="tel" required maxLength={40} autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} className={inputClass} />
        </label>
        <label className={`${labelClass} min-w-0 sm:col-span-2`}>
          <span>Email</span>
          <input name="email" type="email" maxLength={200} autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} />
        </label>
        <label className={`${labelClass} min-w-0 sm:col-span-2`}>
          <span>Notes</span>
          <textarea name="notes" maxLength={1000} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} className={textareaClass} />
        </label>
      </div>
      <FormError message={state.error} />
      <button type="submit" disabled={pending} className={`${buttonPrimary} w-full sm:w-auto`}>
        {pending ? "Adding…" : "Add a customer"}
      </button>
    </form>
  );
}

function CustomerInputs({ customer }: { customer: CustomerFields }) {
  const [name, setName] = useState(customer.name);
  const [phone, setPhone] = useState(customer.phone);
  const [email, setEmail] = useState(customer.email ?? "");
  const [notes, setNotes] = useState(customer.notes);
  return (
    <div className="grid min-w-0 gap-3 sm:grid-cols-2">
      <label className={`${labelClass} min-w-0`}>
        <span>Name</span>
        <input name="name" required maxLength={120} autoComplete="organization" value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
      </label>
      <label className={`${labelClass} min-w-0`}>
        <span>Phone</span>
        <input name="phone" type="tel" required maxLength={40} autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} className={inputClass} />
      </label>
      <label className={`${labelClass} min-w-0 sm:col-span-2`}>
        <span>Email</span>
        <input name="email" type="email" maxLength={200} autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} />
      </label>
      <label className={`${labelClass} min-w-0 sm:col-span-2`}>
        <span>Notes</span>
        <textarea name="notes" maxLength={1000} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} className={textareaClass} />
      </label>
    </div>
  );
}

export function EditCustomerForm({ customer }: { customer: CustomerFields }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useSavedForm(updateCustomerAction, { onOk: () => setOpen(false) });
  return (
    <div className="min-w-0 space-y-3">
      <button type="button" className={`${buttonSecondary} w-full sm:w-auto`} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? "Close" : "Edit customer"}
      </button>
      {open && (
        <form action={action} aria-busy={pending} className="min-w-0 space-y-3">
          <input type="hidden" name="id" value={customer.id} />
          <input type="hidden" name="version" value={customer.version} />
          <CustomerInputs key={customer.version} customer={customer} />
          <FormError message={state.error} />
          <button type="submit" disabled={pending} className={`${buttonPrimary} w-full sm:w-auto`}>
            {pending ? "Saving…" : "Save customer"}
          </button>
        </form>
      )}
    </div>
  );
}

function SiteInputs({
  idPrefix,
  initial,
}: {
  idPrefix: string;
  initial: { label: string; address: string; accessNotes: string; lat: string; lng: string };
}) {
  const [label, setLabel] = useState(initial.label);
  const [address, setAddress] = useState(initial.address);
  const [accessNotes, setAccessNotes] = useState(initial.accessNotes);
  const [lat, setLat] = useState(initial.lat);
  const [lng, setLng] = useState(initial.lng);
  return (
    <div className="grid min-w-0 gap-3">
      <label className={`${labelClass} min-w-0`}>
        <span>Label</span>
        <input name="label" required maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} className={inputClass} />
      </label>
      <label className={`${labelClass} min-w-0`}>
        <span>Address</span>
        <textarea
          name="address"
          required
          maxLength={300}
          rows={2}
          autoComplete="street-address"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          className={textareaClass}
        />
      </label>
      <label className={`${labelClass} min-w-0`}>
        <span>Access notes</span>
        <textarea
          name="accessNotes"
          maxLength={500}
          rows={2}
          value={accessNotes}
          onChange={(e) => setAccessNotes(e.target.value)}
          className={textareaClass}
          aria-describedby={`${idPrefix}-access`}
        />
        <span id={`${idPrefix}-access`} className="text-sm font-normal text-muted">
          Gate codes, parking, who to ask for. The technician sees this on the job.
        </span>
      </label>
      <fieldset className="min-w-0 space-y-3">
        <legend className="text-sm font-medium">Site coordinates</legend>
        <p id={`${idPrefix}-coords`} className="text-sm text-muted">
          Optional. Type both latitude and longitude, or leave both blank. This is the building, not a technician&apos;s phone.
        </p>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <label className={`${labelClass} min-w-0`}>
            <span>Latitude</span>
            <input
              name="lat"
              inputMode="decimal"
              autoComplete="off"
              value={lat}
              onChange={(e) => setLat(e.target.value)}
              className={inputClass}
              aria-describedby={`${idPrefix}-coords`}
            />
          </label>
          <label className={`${labelClass} min-w-0`}>
            <span>Longitude</span>
            <input
              name="lng"
              inputMode="decimal"
              autoComplete="off"
              value={lng}
              onChange={(e) => setLng(e.target.value)}
              className={inputClass}
              aria-describedby={`${idPrefix}-coords`}
            />
          </label>
        </div>
      </fieldset>
    </div>
  );
}

export function AddSiteForm({ customerId }: { customerId: string }) {
  const [formKey, setFormKey] = useState(0);
  const [state, action, pending] = useSavedForm(createSiteAction, {
    opFields: ["label", "address", "accessNotes", "lat", "lng"],
    onOk: () => setFormKey((n) => n + 1),
  });
  return (
    <form action={action} aria-busy={pending} className="min-w-0 space-y-3">
      <input type="hidden" name="customerId" value={customerId} />
      <SiteInputs key={formKey} idPrefix={`new-site-${customerId}`} initial={EMPTY_SITE} />
      <FormError message={state.error} />
      <button type="submit" disabled={pending} className={`${buttonPrimary} w-full sm:w-auto`}>
        {pending ? "Adding…" : "Add a site"}
      </button>
    </form>
  );
}

export function EditSiteForm({ customerId, site }: { customerId: string; site: SiteFields }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useSavedForm(updateSiteAction, { onOk: () => setOpen(false) });
  return (
    <div className="min-w-0 space-y-3">
      <button type="button" className={`${buttonSecondary} w-full sm:w-auto`} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? "Close" : "Edit site"}
      </button>
      {open && (
        <form action={action} aria-busy={pending} className="min-w-0 space-y-3">
          <input type="hidden" name="id" value={site.id} />
          <input type="hidden" name="customerId" value={customerId} />
          <input type="hidden" name="version" value={site.version} />
          <SiteInputs
            key={site.version}
            idPrefix={`site-${site.id}`}
            initial={{
              label: site.label,
              address: site.address,
              accessNotes: site.accessNotes,
              lat: coordText(site.lat),
              lng: coordText(site.lng),
            }}
          />
          <p className="text-sm text-muted">Clearing both coordinates removes them.</p>
          <FormError message={state.error} />
          <button type="submit" disabled={pending} className={`${buttonPrimary} w-full sm:w-auto`}>
            {pending ? "Saving…" : "Save site"}
          </button>
        </form>
      )}
    </div>
  );
}
