import "server-only";
import { and, asc, eq, ilike, or, sql } from "drizzle-orm";
import { z } from "zod";
import { assertCan } from "@/lib/access";
import type { Actor } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { NotFoundError, VersionConflictError } from "@/lib/errors";
import { type JobSummary, selectSummaries } from "@/lib/service-jobs";
import { text } from "@/lib/text";
import type { Tx } from "@/lib/usage";
import { writeTx } from "@/lib/write-tx";

/**
 * Customers and their sites: dispatchers only (any dispatcher sees every customer). Technicians reach a customer's name
 * and phone and a site's address only through the jobs assigned to them (`src/lib/service-jobs.ts`).
 * Creates are idempotent per (dispatcher, `clientOpId`); PATCHes carry `version` (stale: 409 with the current row).
 */

const { customer, site } = schema;

export type CustomerDto = { id: string; name: string; phone: string; email: string | null; notes: string; version: number; createdAt: string; updatedAt: string };
export type SiteDto = { id: string; customerId: string; label: string; address: string; lat: number | null; lng: number | null; accessNotes: string; version: number };

const num = (v: string | null) => (v === null ? null : Number(v));
const uuid = z.string().uuid();

const toCustomer = (r: typeof customer.$inferSelect): CustomerDto => ({
  id: r.id,
  name: r.name,
  phone: r.phone,
  email: r.email,
  notes: r.notes,
  version: r.version,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});
const toSite = (r: typeof site.$inferSelect): SiteDto => ({
  id: r.id,
  customerId: r.customerId,
  label: r.label,
  address: r.address,
  lat: num(r.lat),
  lng: num(r.lng),
  accessNotes: r.accessNotes,
  version: r.version,
});

const email = text(200).refine((v) => v === "" || z.email().safeParse(v).success, "Not a valid email address");

export const newCustomerInput = z.strictObject({
  name: text(120, { min: 1, minMessage: "Name is required" }),
  phone: text(40, { min: 1, minMessage: "Phone is required" }),
  email: email.nullish().transform((v) => v || null),
  notes: text(1000).default(""),
  clientOpId: uuid.optional(),
});

export const customerPatchInput = z.strictObject({
  version: z.number().int().min(1),
  name: text(120, { min: 1, minMessage: "Name is required" }).optional(),
  phone: text(40, { min: 1, minMessage: "Phone is required" }).optional(),
  email: email.nullable().transform((v) => v || null).optional(),
  notes: text(1000).optional(),
});

const coordinate = (min: number, max: number) => z.number().min(min).max(max);

const siteFields = {
  label: text(80, { min: 1, minMessage: "Label is required" }),
  address: text(300, { min: 1, minMessage: "Address is required" }),
  accessNotes: text(500),
};
const coordsOk = (v: { lat?: number | null; lng?: number | null }, ctx: z.RefinementCtx) => {
  if ((v.lat === undefined || v.lat === null) !== (v.lng === undefined || v.lng === null)) {
    ctx.addIssue({ code: "custom", path: ["lng"], message: "Give both lat and lng, or neither" });
  }
};

export const newSiteInput = z
  .strictObject({
    label: siteFields.label,
    address: siteFields.address,
    accessNotes: siteFields.accessNotes.default(""),
    lat: coordinate(-90, 90).nullish(),
    lng: coordinate(-180, 180).nullish(),
    clientOpId: uuid.optional(),
  })
  .superRefine(coordsOk);

export const sitePatchInput = z
  .strictObject({
    version: z.number().int().min(1),
    label: siteFields.label.optional(),
    address: siteFields.address.optional(),
    accessNotes: siteFields.accessNotes.optional(),
    lat: coordinate(-90, 90).nullable().optional(),
    lng: coordinate(-180, 180).nullable().optional(),
  })
  .superRefine(coordsOk);

export const customerListQuery = z.strictObject({
  q: text(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function listCustomers(actor: Actor, input: unknown): Promise<{ customers: (CustomerDto & { siteCount: number })[]; hasMore: boolean }> {
  assertCan(actor, "read", "customer");
  const f = customerListQuery.parse(input ?? {});
  const like = f.q ? `%${escapeLike(f.q)}%` : undefined;
  const rows = await db()
    .select({ c: customer, siteCount: sql<number>`(select count(*)::int from ${site} where ${site.customerId} = ${customer.id})` })
    .from(customer)
    .where(like ? or(ilike(customer.name, like), ilike(customer.phone, like), ilike(customer.email, like)) : undefined)
    .orderBy(asc(customer.name), asc(customer.id))
    .limit(f.limit + 1)
    .offset(f.offset);
  return { customers: rows.slice(0, f.limit).map((r) => ({ ...toCustomer(r.c), siteCount: r.siteCount })), hasMore: rows.length > f.limit };
}

export async function getCustomer(actor: Actor, id: string): Promise<{ customer: CustomerDto; sites: SiteDto[]; jobs: JobSummary[] }> {
  assertCan(actor, "read", "customer");
  const customerId = uuid.parse(id);
  const [row] = await db().select().from(customer).where(eq(customer.id, customerId));
  if (!row) throw new NotFoundError("Customer not found");
  const sites = await db().select().from(site).where(eq(site.customerId, customerId)).orderBy(asc(site.label), asc(site.id));
  const jobs = await selectSummaries(db(), eq(schema.serviceJob.customerId, customerId), { limit: 50 });
  return { customer: toCustomer(row), sites: sites.map(toSite), jobs };
}

export async function createCustomer(actor: Actor, input: unknown): Promise<{ customer: CustomerDto; created: boolean }> {
  assertCan(actor, "create", "customer");
  const data = newCustomerInput.parse(input);
  return writeTx(actor, async (tx) => {
    const [row] = await tx
      .insert(customer)
      .values({ name: data.name, phone: data.phone, email: data.email, notes: data.notes, clientOpId: data.clientOpId ?? null, createdBy: actor.id })
      .onConflictDoNothing({ target: [customer.createdBy, customer.clientOpId] })
      .returning();
    if (row) return { customer: toCustomer(row), created: true };
    // The same op id came in before (a retry after a lost response): return the row it created.
    const [existing] = await tx
      .select()
      .from(customer)
      .where(and(eq(customer.createdBy, actor.id), eq(customer.clientOpId, data.clientOpId ?? "")));
    return { customer: toCustomer(existing), created: false };
  });
}

export async function updateCustomer(actor: Actor, id: string, input: unknown): Promise<CustomerDto> {
  assertCan(actor, "update", "customer");
  const customerId = uuid.parse(id);
  const { version, ...fields } = customerPatchInput.parse(input);
  return writeTx(actor, async (tx) => {
    const [row] = await tx
      .update(customer)
      .set({ ...fields, version: version + 1, updatedAt: new Date() })
      .where(and(eq(customer.id, customerId), eq(customer.version, version)))
      .returning();
    if (row) return toCustomer(row);
    const [current] = await tx.select().from(customer).where(eq(customer.id, customerId));
    if (!current) throw new NotFoundError("Customer not found");
    throw new VersionConflictError(toCustomer(current));
  });
}

export async function createSite(actor: Actor, customerId: string, input: unknown): Promise<{ site: SiteDto; created: boolean }> {
  assertCan(actor, "create", "site");
  const parentId = uuid.parse(customerId);
  const data = newSiteInput.parse(input);
  return writeTx(actor, async (tx) => {
    const [parent] = await tx.select({ id: customer.id }).from(customer).where(eq(customer.id, parentId));
    if (!parent) throw new NotFoundError("Customer not found");
    return insertSite(tx, actor, parentId, data);
  });
}

async function insertSite(tx: Tx, actor: Actor, customerId: string, data: z.infer<typeof newSiteInput>) {
  const [row] = await tx
    .insert(site)
    .values({
      customerId,
      label: data.label,
      address: data.address,
      accessNotes: data.accessNotes,
      lat: data.lat === undefined || data.lat === null ? null : String(data.lat),
      lng: data.lng === undefined || data.lng === null ? null : String(data.lng),
      clientOpId: data.clientOpId ?? null,
      createdBy: actor.id,
    })
    .onConflictDoNothing({ target: [site.createdBy, site.clientOpId] })
    .returning();
  if (row) return { site: toSite(row), created: true };
  const [existing] = await tx
    .select()
    .from(site)
    .where(and(eq(site.createdBy, actor.id), eq(site.clientOpId, data.clientOpId ?? "")));
  return { site: toSite(existing), created: false };
}

export async function updateSite(actor: Actor, id: string, input: unknown): Promise<SiteDto> {
  assertCan(actor, "update", "site");
  const siteId = uuid.parse(id);
  const { version, lat, lng, ...fields } = sitePatchInput.parse(input);
  return writeTx(actor, async (tx) => {
    const [row] = await tx
      .update(site)
      .set({
        ...fields,
        ...(lat !== undefined ? { lat: lat === null ? null : String(lat) } : {}),
        ...(lng !== undefined ? { lng: lng === null ? null : String(lng) } : {}),
        version: version + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(site.id, siteId), eq(site.version, version)))
      .returning();
    if (row) return toSite(row);
    const [current] = await tx.select().from(site).where(eq(site.id, siteId));
    if (!current) throw new NotFoundError("Site not found");
    throw new VersionConflictError(toSite(current));
  });
}
