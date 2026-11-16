"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/session";
import { createCustomer, createSite, updateCustomer, updateSite } from "@/lib/customers";
import { type ActionState, actionFailure, read, versionOf } from "@/lib/form-errors";

const CUSTOMER_LABELS: Record<string, string> = {
  name: "Name",
  phone: "Phone",
  email: "Email",
  notes: "Notes",
};

const SITE_LABELS: Record<string, string> = {
  label: "Label",
  address: "Address",
  accessNotes: "Access notes",
  lat: "Latitude",
  lng: "Longitude",
};

function revalidateCustomer(id: string) {
  revalidatePath("/customers");
  revalidatePath(`/customers/${id}`);
}

/** Blank coordinates mean "none". One without the other is a form error, not a database write. */
function coordinates(form: FormData): { lat: number | null; lng: number | null } | { error: string } {
  const latRaw = read(form, "lat").trim();
  const lngRaw = read(form, "lng").trim();
  if (!latRaw && !lngRaw) return { lat: null, lng: null };
  if (!latRaw || !lngRaw) return { error: "Give both latitude and longitude, or leave both blank." };
  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { error: "Latitude and longitude must be numbers." };
  return { lat, lng };
}

export async function createCustomerAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const user = await requireRole("dispatcher");
    const clientOpId = read(form, "clientOpId");
    const { customer } = await createCustomer(user, {
      name: read(form, "name"),
      phone: read(form, "phone"),
      email: read(form, "email"),
      notes: read(form, "notes"),
      clientOpId: clientOpId || undefined,
    });
    revalidateCustomer(customer.id);
    return { ok: true, id: customer.id };
  } catch (err) {
    return actionFailure(err, CUSTOMER_LABELS);
  }
}

export async function updateCustomerAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const version = versionOf(form);
  if (!version) return { error: "This page is out of date. Reload it and try again." };
  const id = read(form, "id");
  try {
    const user = await requireRole("dispatcher");
    await updateCustomer(user, id, {
      version,
      name: read(form, "name"),
      phone: read(form, "phone"),
      email: read(form, "email"),
      notes: read(form, "notes"),
    });
    revalidateCustomer(id);
    return { ok: true };
  } catch (err) {
    return actionFailure(err, CUSTOMER_LABELS);
  }
}

export async function createSiteAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const coords = coordinates(form);
  if ("error" in coords) return { error: coords.error };
  const customerId = read(form, "customerId");
  try {
    const user = await requireRole("dispatcher");
    const clientOpId = read(form, "clientOpId");
    await createSite(user, customerId, {
      label: read(form, "label"),
      address: read(form, "address"),
      accessNotes: read(form, "accessNotes"),
      clientOpId: clientOpId || undefined,
      ...(coords.lat !== null && coords.lng !== null ? { lat: coords.lat, lng: coords.lng } : {}),
    });
    revalidateCustomer(customerId);
    return { ok: true };
  } catch (err) {
    return actionFailure(err, SITE_LABELS);
  }
}

export async function updateSiteAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const version = versionOf(form);
  if (!version) return { error: "This page is out of date. Reload it and try again." };
  const coords = coordinates(form);
  if ("error" in coords) return { error: coords.error };
  const id = read(form, "id");
  const customerId = read(form, "customerId");
  try {
    const user = await requireRole("dispatcher");
    await updateSite(user, id, {
      version,
      label: read(form, "label"),
      address: read(form, "address"),
      accessNotes: read(form, "accessNotes"),
      lat: coords.lat,
      lng: coords.lng,
    });
    revalidateCustomer(customerId);
    return { ok: true };
  } catch (err) {
    return actionFailure(err, SITE_LABELS);
  }
}
