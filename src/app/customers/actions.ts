"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/session";
import { type ActionState, actionFailure } from "@/lib/action-error";
import { createCustomer, createSite, updateCustomer, updateSite } from "@/lib/customers";

function read(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}

function refreshCustomers(id?: string) {
  revalidatePath("/customers");
  revalidatePath("/customers/[id]", "page");
  if (id) revalidatePath(`/customers/${id}`);
}

export async function createCustomerAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const user = await requireRole("dispatcher");
    const customer = await createCustomer(user, {
      name: read(form, "name"),
      phone: read(form, "phone"),
      email: read(form, "email"),
      notes: read(form, "notes"),
      clientOpId: read(form, "clientOpId"),
    });
    refreshCustomers(customer.id);
    return { ok: true, id: customer.id };
  } catch (err) {
    const failure = actionFailure(err);
    if (failure) return failure;
    throw err;
  }
}

export async function updateCustomerAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const user = await requireRole("dispatcher");
    const customer = await updateCustomer(user, {
      id: read(form, "id"),
      version: read(form, "version"),
      name: read(form, "name"),
      phone: read(form, "phone"),
      email: read(form, "email"),
      notes: read(form, "notes"),
    });
    refreshCustomers(customer.id);
    return { ok: true, id: customer.id };
  } catch (err) {
    const failure = actionFailure(err);
    if (failure) return failure;
    throw err;
  }
}

export async function createSiteAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const user = await requireRole("dispatcher");
    const site = await createSite(user, {
      customerId: read(form, "customerId"),
      clientOpId: read(form, "clientOpId"),
      label: read(form, "label"),
      address: read(form, "address"),
      accessNotes: read(form, "accessNotes"),
      lat: read(form, "lat"),
      lng: read(form, "lng"),
    });
    refreshCustomers(site.customerId);
    return { ok: true, id: site.id };
  } catch (err) {
    const failure = actionFailure(err);
    if (failure) return failure;
    throw err;
  }
}

export async function updateSiteAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const user = await requireRole("dispatcher");
    const site = await updateSite(user, {
      id: read(form, "id"),
      version: read(form, "version"),
      label: read(form, "label"),
      address: read(form, "address"),
      accessNotes: read(form, "accessNotes"),
      lat: read(form, "lat"),
      lng: read(form, "lng"),
    });
    refreshCustomers(site.customerId);
    return { ok: true, id: site.id };
  } catch (err) {
    const failure = actionFailure(err);
    if (failure) return failure;
    throw err;
  }
}
