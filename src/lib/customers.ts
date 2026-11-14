import "server-only";
import { and, asc, desc, eq, or, sql } from "drizzle-orm";
import { z } from "zod";
import { type Actor } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { type JobPriority, type ServiceJobStatus } from "@/lib/db/schema";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { DISPATCH_WRITE_LIMIT, DISPATCH_WRITE_MESSAGE, assertDispatcher } from "@/lib/office";
import { text } from "@/lib/text";
import { type Tx, consumeRate, releaseRate } from "@/lib/usage";

/**
 * Customers and sites for dispatchers. Every function takes the acting user and refuses anyone else,
 * including admins, with the same 404 a missing row gets.
 */

const optionalEmail = text(200).refine((value) => value === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), "Enter a valid email");

const coord = text(20).refine(
  (value) => value === "" || /^-?\d{1,3}(\.\d{1,5})?$/.test(value),
  "Use a decimal coordinate with at most 5 decimal places.",
);

const customerFields = {
  name: text(120, { min: 1, minMessage: "Customer name is required" }),
  phone: text(40).default(""),
  email: optionalEmail.default(""),
  notes: text(1000).default(""),
};

export const createCustomerInput = z.object({
  ...customerFields,
  clientOpId: z.uuid(),
});

export const updateCustomerInput = z.object({
  id: z.uuid(),
  version: z.coerce.number().int().positive(),
  ...customerFields,
});

const siteFields = z.object({
  label: text(80, { min: 1, minMessage: "Site label is required" }),
  address: text(300, { min: 1, minMessage: "Address is required" }),
  accessNotes: text(500).default(""),
  lat: coord.default(""),
  lng: coord.default(""),
});

function refineCoords(input: { lat: string; lng: string }, ctx: z.core.$RefinementCtx<{ lat: string; lng: string }>) {
  if (!input.lat && !input.lng) return;
  if (!input.lat || !input.lng) {
    ctx.addIssue({ code: "custom", message: "Enter both latitude and longitude, or leave both blank.", path: ["lat"] });
    return;
  }
  const lat = Number(input.lat);
  const lng = Number(input.lng);
  if (lat < -90 || lat > 90) ctx.addIssue({ code: "custom", message: "Latitude must be between -90 and 90.", path: ["lat"] });
  if (lng < -180 || lng > 180) ctx.addIssue({ code: "custom", message: "Longitude must be between -180 and 180.", path: ["lng"] });
}

export const createSiteInput = siteFields
  .extend({
    customerId: z.uuid(),
    clientOpId: z.uuid(),
  })
  .superRefine(refineCoords);

export const updateSiteInput = siteFields
  .extend({
    id: z.uuid(),
    version: z.coerce.number().int().positive(),
  })
  .superRefine(refineCoords);

export type CustomerRecord = {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  notes: string;
  version: number;
};

export type SiteRecord = {
  id: string;
  customerId: string;
  label: string;
  address: string;
  accessNotes: string;
  lat: string | null;
  lng: string | null;
  version: number;
};

export type CustomerListItem = {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  siteCount: number;
  jobCount: number;
};

export type CustomerList = { rows: CustomerListItem[]; total: number; truncated: boolean };

export type CustomerJob = {
  id: string;
  number: number;
  title: string;
  status: ServiceJobStatus;
  priority: JobPriority;
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  assigneeName: string | null;
};

export type CustomerDetail = CustomerRecord & {
  sites: SiteRecord[];
  jobs: CustomerJob[];
  sitesTruncated: boolean;
  jobsTruncated: boolean;
};

const listFilters = z.object({
  q: text(100).optional(),
  sort: z.enum(["name", "newest"]).optional(),
});

const likeEscape = (value: string) => `%${value.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

function toCustomer(row: typeof schema.customer.$inferSelect): CustomerRecord {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    notes: row.notes,
    version: row.version,
  };
}

function toSite(row: typeof schema.site.$inferSelect): SiteRecord {
  return {
    id: row.id,
    customerId: row.customerId,
    label: row.label,
    address: row.address,
    accessNotes: row.accessNotes,
    lat: row.lat,
    lng: row.lng,
    version: row.version,
  };
}

function coordEqual(stored: string | null, incoming: string | null): boolean {
  if (!stored && !incoming) return true;
  if (!stored || !incoming) return false;
  return Number(stored) === Number(incoming);
}

export async function listCustomers(actor: Actor, filters: unknown = {}): Promise<CustomerList> {
  assertDispatcher(actor);
  const parsed = listFilters.parse(filters);
  const conditions = [];
  if (parsed.q) {
    const term = likeEscape(parsed.q);
    conditions.push(
      or(
        sql`${schema.customer.name} ilike ${term} escape '\\'`,
        sql`${schema.customer.phone} ilike ${term} escape '\\'`,
        sql`${schema.customer.email} ilike ${term} escape '\\'`,
      )!,
    );
  }
  const where = conditions.length ? and(...conditions) : undefined;
  const [{ n }] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.customer)
    .where(where);
  const total = Number(n);
  const siteCount = sql<number>`(select count(*)::int from site where site.customer_id = ${schema.customer.id})`;
  const jobCount = sql<number>`(select count(*)::int from service_job where service_job.customer_id = ${schema.customer.id})`;
  const order = parsed.sort === "newest" ? [desc(schema.customer.createdAt)] : [asc(schema.customer.name), asc(schema.customer.id)];
  const rows = await db()
    .select({
      id: schema.customer.id,
      name: schema.customer.name,
      phone: schema.customer.phone,
      email: schema.customer.email,
      siteCount,
      jobCount,
    })
    .from(schema.customer)
    .where(where)
    .orderBy(...order)
    .limit(200);
  return {
    rows: rows.map((row) => ({ ...row, siteCount: Number(row.siteCount), jobCount: Number(row.jobCount) })),
    total,
    truncated: total > rows.length,
  };
}

export async function getCustomer(actor: Actor, id: string): Promise<CustomerDetail> {
  assertDispatcher(actor);
  const customerId = z.uuid().parse(id);
  const [row] = await db().select().from(schema.customer).where(eq(schema.customer.id, customerId)).limit(1);
  if (!row) throw new NotFoundError();
  const sites = await db()
    .select()
    .from(schema.site)
    .where(eq(schema.site.customerId, customerId))
    .orderBy(asc(schema.site.label), asc(schema.site.id))
    .limit(101);
  const jobs = await db()
    .select({
      id: schema.serviceJob.id,
      number: schema.serviceJob.number,
      title: schema.serviceJob.title,
      status: schema.serviceJob.status,
      priority: schema.serviceJob.priority,
      scheduledStart: schema.serviceJob.scheduledStart,
      scheduledEnd: schema.serviceJob.scheduledEnd,
      assigneeName: schema.user.name,
    })
    .from(schema.serviceJob)
    .leftJoin(schema.user, eq(schema.serviceJob.assigneeId, schema.user.id))
    .where(eq(schema.serviceJob.customerId, customerId))
    .orderBy(desc(schema.serviceJob.createdAt))
    .limit(101);
  return {
    ...toCustomer(row),
    sites: sites.slice(0, 100).map(toSite),
    jobs: jobs.slice(0, 100),
    sitesTruncated: sites.length > 100,
    jobsTruncated: jobs.length > 100,
  };
}

async function findCustomerOp(tx: Tx, actorId: string, clientOpId: string): Promise<string | undefined> {
  const [row] = await tx
    .select({ id: schema.customer.id })
    .from(schema.customer)
    .where(and(eq(schema.customer.createdBy, actorId), eq(schema.customer.clientOpId, clientOpId)))
    .limit(1);
  return row?.id;
}

export async function createCustomer(actor: Actor, input: unknown): Promise<CustomerRecord> {
  assertDispatcher(actor);
  const data = createCustomerInput.parse(input);
  return db().transaction(async (tx) => {
    const existingId = await findCustomerOp(tx, actor.id, data.clientOpId);
    if (existingId) {
      const [existing] = await tx.select().from(schema.customer).where(eq(schema.customer.id, existingId)).limit(1);
      if (!existing) throw new NotFoundError();
      return toCustomer(existing);
    }
    await consumeRate(tx, actor.id, "api_write", DISPATCH_WRITE_LIMIT, DISPATCH_WRITE_MESSAGE);
    const raced = await findCustomerOp(tx, actor.id, data.clientOpId);
    if (raced) {
      await releaseRate(tx, actor.id, "api_write");
      const [existing] = await tx.select().from(schema.customer).where(eq(schema.customer.id, raced)).limit(1);
      if (!existing) throw new NotFoundError();
      return toCustomer(existing);
    }
    const [inserted] = await tx
      .insert(schema.customer)
      .values({
        createdBy: actor.id,
        name: data.name,
        phone: data.phone,
        email: data.email || null,
        notes: data.notes,
        clientOpId: data.clientOpId,
      })
      .onConflictDoNothing({ target: [schema.customer.createdBy, schema.customer.clientOpId] })
      .returning();
    if (inserted) return toCustomer(inserted);
    await releaseRate(tx, actor.id, "api_write");
    const again = await findCustomerOp(tx, actor.id, data.clientOpId);
    if (!again) throw new ConflictError("That customer could not be saved. Try again.");
    const [existing] = await tx.select().from(schema.customer).where(eq(schema.customer.id, again)).limit(1);
    if (!existing) throw new NotFoundError();
    return toCustomer(existing);
  });
}

export async function updateCustomer(actor: Actor, input: unknown): Promise<CustomerRecord> {
  assertDispatcher(actor);
  const data = updateCustomerInput.parse(input);
  return db().transaction(async (tx) => {
    const [row] = await tx.select().from(schema.customer).where(eq(schema.customer.id, data.id)).limit(1).for("update");
    if (!row) throw new NotFoundError();
    const next = { name: data.name, phone: data.phone, email: data.email || null, notes: data.notes };
    const same = row.name === next.name && row.phone === next.phone && (row.email ?? null) === next.email && row.notes === next.notes;
    if (same) return toCustomer(row);
    if (row.version !== data.version) throw new ConflictError("This customer changed. Reload and try again.");
    await consumeRate(tx, actor.id, "api_write", DISPATCH_WRITE_LIMIT, DISPATCH_WRITE_MESSAGE);
    const [updated] = await tx
      .update(schema.customer)
      .set({ ...next, version: sql`${schema.customer.version} + 1`, updatedAt: new Date() })
      .where(and(eq(schema.customer.id, row.id), eq(schema.customer.version, data.version)))
      .returning();
    if (!updated) throw new ConflictError("This customer changed. Reload and try again.");
    return toCustomer(updated);
  });
}

async function findSiteOp(tx: Tx, customerId: string, clientOpId: string): Promise<string | undefined> {
  const [row] = await tx
    .select({ id: schema.site.id })
    .from(schema.site)
    .where(and(eq(schema.site.customerId, customerId), eq(schema.site.clientOpId, clientOpId)))
    .limit(1);
  return row?.id;
}

async function loadSite(tx: Tx, id: string): Promise<SiteRecord> {
  const [row] = await tx.select().from(schema.site).where(eq(schema.site.id, id)).limit(1);
  if (!row) throw new NotFoundError();
  return toSite(row);
}

export async function createSite(actor: Actor, input: unknown): Promise<SiteRecord> {
  assertDispatcher(actor);
  const data = createSiteInput.parse(input);
  return db().transaction(async (tx) => {
    const [owner] = await tx.select({ id: schema.customer.id }).from(schema.customer).where(eq(schema.customer.id, data.customerId)).limit(1);
    if (!owner) throw new NotFoundError();
    const existingId = await findSiteOp(tx, data.customerId, data.clientOpId);
    if (existingId) return loadSite(tx, existingId);
    await consumeRate(tx, actor.id, "api_write", DISPATCH_WRITE_LIMIT, DISPATCH_WRITE_MESSAGE);
    const raced = await findSiteOp(tx, data.customerId, data.clientOpId);
    if (raced) {
      await releaseRate(tx, actor.id, "api_write");
      return loadSite(tx, raced);
    }
    const [inserted] = await tx
      .insert(schema.site)
      .values({
        customerId: data.customerId,
        label: data.label,
        address: data.address,
        accessNotes: data.accessNotes,
        lat: data.lat || null,
        lng: data.lng || null,
        clientOpId: data.clientOpId,
      })
      .onConflictDoNothing({ target: [schema.site.customerId, schema.site.clientOpId] })
      .returning({ id: schema.site.id });
    if (inserted) return loadSite(tx, inserted.id);
    await releaseRate(tx, actor.id, "api_write");
    const again = await findSiteOp(tx, data.customerId, data.clientOpId);
    if (!again) throw new ConflictError("That site could not be saved. Try again.");
    return loadSite(tx, again);
  });
}

export async function updateSite(actor: Actor, input: unknown): Promise<SiteRecord> {
  assertDispatcher(actor);
  const data = updateSiteInput.parse(input);
  return db().transaction(async (tx) => {
    const [row] = await tx.select().from(schema.site).where(eq(schema.site.id, data.id)).limit(1).for("update");
    if (!row) throw new NotFoundError();
    const next = {
      label: data.label,
      address: data.address,
      accessNotes: data.accessNotes,
      lat: data.lat || null,
      lng: data.lng || null,
    };
    const same =
      row.label === next.label &&
      row.address === next.address &&
      row.accessNotes === next.accessNotes &&
      coordEqual(row.lat, next.lat) &&
      coordEqual(row.lng, next.lng);
    if (same) return toSite(row);
    if (row.version !== data.version) throw new ConflictError("This site changed. Reload and try again.");
    await consumeRate(tx, actor.id, "api_write", DISPATCH_WRITE_LIMIT, DISPATCH_WRITE_MESSAGE);
    const [updated] = await tx
      .update(schema.site)
      .set({ ...next, version: sql`${schema.site.version} + 1`, updatedAt: new Date() })
      .where(and(eq(schema.site.id, row.id), eq(schema.site.version, data.version)))
      .returning();
    if (!updated) throw new ConflictError("This site changed. Reload and try again.");
    return toSite(updated);
  });
}
