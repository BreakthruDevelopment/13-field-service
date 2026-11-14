import "server-only";
import { and, asc, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { type Actor } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { JOB_PRIORITIES, OPEN_SERVICE_JOB_STATUSES, SERVICE_JOB_STATUSES, type JobPriority, type ServiceJobStatus } from "@/lib/db/schema";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/errors";
import { text } from "@/lib/text";
import { consumeRate, releaseRate } from "@/lib/usage";
import { MAX_WINDOW_MS, parseUtcDay, parseUtcInstant, utcDayBounds } from "@/lib/dispatch-view";

/**
 * Dispatcher schedule data. Every function takes the acting user and refuses anyone who is not a
 * dispatcher, including admins (they see counts only). The template's `can()` is not used.
 */

const OPEN_JOB_CAP = 2000;
const DISPATCH_WRITE_LIMIT = 300;

/** Anyone but a dispatcher gets the same 404 a missing row would, so the role can't be probed. */
function assertDispatcher(actor: Actor): void {
  if (actor.role !== "dispatcher") throw new NotFoundError();
}

const prioritySchema = z.enum(JOB_PRIORITIES);
const statusSchema = z.enum(SERVICE_JOB_STATUSES);

const optionalEmail = text(200).refine((value) => value === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), "Enter a valid email");

const newCustomerInput = z.object({
  name: text(120, { min: 1, minMessage: "Customer name is required" }),
  phone: text(40).default(""),
  email: optionalEmail.default(""),
  notes: text(1000).default(""),
  clientOpId: z.uuid(),
});

const newSiteInput = z.object({
  label: text(80, { min: 1, minMessage: "Site label is required" }),
  address: text(300, { min: 1, minMessage: "Address is required" }),
  accessNotes: text(500).default(""),
  clientOpId: z.uuid(),
});

export const createDispatchJobInput = z
  .object({
    clientOpId: z.uuid(),
    customerId: z.uuid().optional(),
    customer: newCustomerInput.optional(),
    siteId: z.uuid().optional(),
    site: newSiteInput.optional(),
    title: text(120, { min: 1, minMessage: "Title is required" }),
    description: text(2000).default(""),
    priority: prioritySchema.default("normal"),
    assigneeId: z.string().trim().min(1).optional(),
    scheduledStart: z.string().optional(),
    scheduledEnd: z.string().optional(),
  })
  .superRefine((input, ctx) => {
    if (!input.customerId && !input.customer) {
      ctx.addIssue({ code: "custom", message: "Choose a customer or enter a new one.", path: ["customer"] });
    }
    if (input.customerId && input.customer) {
      ctx.addIssue({ code: "custom", message: "Pick an existing customer or a new one, not both.", path: ["customer"] });
    }
    if (!input.siteId && !input.site) {
      ctx.addIssue({ code: "custom", message: "Choose a site or enter a new one.", path: ["site"] });
    }
    if (input.siteId && input.site) {
      ctx.addIssue({ code: "custom", message: "Pick an existing site or a new one, not both.", path: ["site"] });
    }
    if (!input.customerId && input.siteId) {
      ctx.addIssue({ code: "custom", message: "A new customer needs a new site.", path: ["siteId"] });
    }
    const hasAssignee = Boolean(input.assigneeId);
    const start = input.scheduledStart ? parseUtcInstant(input.scheduledStart) : null;
    const end = input.scheduledEnd ? parseUtcInstant(input.scheduledEnd) : null;
    if ((input.scheduledStart && !start) || (input.scheduledEnd && !end)) {
      ctx.addIssue({ code: "custom", message: "Enter a valid start and end.", path: ["scheduledStart"] });
      return;
    }
    if (hasAssignee && (!start || !end)) {
      ctx.addIssue({ code: "custom", message: "Set a start and end to assign this job.", path: ["scheduledStart"] });
      return;
    }
    if (!hasAssignee && (start || end)) {
      ctx.addIssue({ code: "custom", message: "Choose a technician before setting a time window.", path: ["assigneeId"] });
      return;
    }
    if (start && end) {
      const span = end.getTime() - start.getTime();
      if (span <= 0) ctx.addIssue({ code: "custom", message: "End must be after start.", path: ["scheduledEnd"] });
      else if (span > MAX_WINDOW_MS) ctx.addIssue({ code: "custom", message: "A visit can't be longer than 12 hours.", path: ["scheduledEnd"] });
    }
  });

export type CreateDispatchJobInput = z.infer<typeof createDispatchJobInput>;

export type DispatchJob = {
  id: string;
  number: number;
  title: string;
  description: string;
  priority: JobPriority;
  status: ServiceJobStatus;
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  assigneeId: string | null;
  assigneeName: string | null;
  customerId: string;
  customerName: string;
  customerPhone: string;
  siteId: string;
  siteLabel: string;
  siteAddress: string;
  version: number;
};

export type CustomerOption = {
  id: string;
  name: string;
  phone: string;
  sites: { id: string; label: string; address: string }[];
};

export type TechnicianOption = { id: string; name: string; email: string };

const jobSelect = {
  id: schema.serviceJob.id,
  number: schema.serviceJob.number,
  title: schema.serviceJob.title,
  description: schema.serviceJob.description,
  priority: schema.serviceJob.priority,
  status: schema.serviceJob.status,
  scheduledStart: schema.serviceJob.scheduledStart,
  scheduledEnd: schema.serviceJob.scheduledEnd,
  assigneeId: schema.serviceJob.assigneeId,
  assigneeName: schema.user.name,
  customerId: schema.customer.id,
  customerName: schema.customer.name,
  customerPhone: schema.customer.phone,
  siteId: schema.site.id,
  siteLabel: schema.site.label,
  siteAddress: schema.site.address,
  version: schema.serviceJob.version,
};

function jobQuery() {
  return db()
    .select(jobSelect)
    .from(schema.serviceJob)
    .innerJoin(schema.customer, eq(schema.serviceJob.customerId, schema.customer.id))
    .innerJoin(schema.site, eq(schema.serviceJob.siteId, schema.site.id))
    .leftJoin(schema.user, eq(schema.serviceJob.assigneeId, schema.user.id));
}

const likeEscape = (value: string) => `%${value.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

export async function listTechnicians(actor: Actor): Promise<TechnicianOption[]> {
  assertDispatcher(actor);
  return db()
    .select({ id: schema.user.id, name: schema.user.name, email: schema.user.email })
    .from(schema.user)
    .where(eq(schema.user.role, "technician"))
    .orderBy(asc(schema.user.name))
    .limit(200);
}

export async function listCustomersWithSites(actor: Actor): Promise<CustomerOption[]> {
  assertDispatcher(actor);
  const customers = await db()
    .select({
      id: schema.customer.id,
      name: schema.customer.name,
      phone: schema.customer.phone,
    })
    .from(schema.customer)
    .orderBy(asc(schema.customer.name))
    .limit(500);
  if (customers.length === 0) return [];
  const sites = await db()
    .select({
      id: schema.site.id,
      customerId: schema.site.customerId,
      label: schema.site.label,
      address: schema.site.address,
    })
    .from(schema.site)
    .where(inArray(schema.site.customerId, customers.map((c) => c.id)))
    .orderBy(asc(schema.site.label))
    .limit(2000);
  const byCustomer = new Map<string, CustomerOption["sites"]>();
  for (const site of sites) {
    const list = byCustomer.get(site.customerId) ?? [];
    list.push({ id: site.id, label: site.label, address: site.address });
    byCustomer.set(site.customerId, list);
  }
  return customers.map((c) => ({ ...c, sites: byCustomer.get(c.id) ?? [] }));
}

const listFilters = z.object({
  q: text(100).optional(),
  status: z.union([statusSchema, z.literal("")]).optional(),
  priority: z.union([prioritySchema, z.literal("")]).optional(),
  assignee: z.string().trim().max(200).optional(),
  sort: z.enum(["newest", "scheduled", "priority"]).optional(),
});

export async function listDispatchJobs(actor: Actor, filters: unknown = {}): Promise<DispatchJob[]> {
  assertDispatcher(actor);
  const parsed = listFilters.parse(filters);
  const conditions = [];
  if (parsed.status) conditions.push(eq(schema.serviceJob.status, parsed.status));
  if (parsed.priority) conditions.push(eq(schema.serviceJob.priority, parsed.priority));
  if (parsed.assignee === "unassigned") conditions.push(sql`${schema.serviceJob.assigneeId} is null`);
  else if (parsed.assignee && parsed.assignee !== "all") conditions.push(eq(schema.serviceJob.assigneeId, parsed.assignee));
  if (parsed.q) {
    const term = likeEscape(parsed.q);
    conditions.push(
      or(
        sql`${schema.serviceJob.title} ilike ${term} escape '\\'`,
        sql`${schema.customer.name} ilike ${term} escape '\\'`,
        sql`${schema.site.address} ilike ${term} escape '\\'`,
        sql`${schema.site.label} ilike ${term} escape '\\'`,
      )!,
    );
  }
  const sort = parsed.sort ?? "newest";
  const priorityOrder = sql`case ${schema.serviceJob.priority} when 'emergency' then 0 when 'high' then 1 when 'normal' then 2 else 3 end`;
  const order =
    sort === "priority"
      ? [asc(priorityOrder), desc(schema.serviceJob.createdAt)]
      : sort === "scheduled"
        ? [sql`${schema.serviceJob.scheduledStart} asc nulls last`, desc(schema.serviceJob.createdAt)]
        : [desc(schema.serviceJob.createdAt)];
  const query = jobQuery();
  const filtered = conditions.length ? query.where(and(...conditions)) : query;
  return filtered.orderBy(...order).limit(200);
}

export type BoardLane = { technicianId: string; name: string; jobs: DispatchJob[] };

export type DispatchBoard = {
  date: string;
  unassigned: DispatchJob[];
  lanes: BoardLane[];
  truncated: boolean;
};

/** One job query (at most 200 rows) plus the technician list for empty lanes. */
export async function listBoard(actor: Actor, dateInput: string | undefined): Promise<DispatchBoard> {
  assertDispatcher(actor);
  const date = parseUtcDay(dateInput);
  const { start, end } = utcDayBounds(date);
  const jobs = await jobQuery()
    .where(
      and(
        sql`${schema.serviceJob.status} <> 'cancelled'`,
        or(
          and(sql`${schema.serviceJob.scheduledStart} is null`, eq(schema.serviceJob.status, "unassigned")),
          and(lt(schema.serviceJob.scheduledStart, end), gt(schema.serviceJob.scheduledEnd, start)),
        ),
      ),
    )
    .orderBy(sql`${schema.serviceJob.scheduledStart} asc nulls last`, desc(schema.serviceJob.createdAt))
    .limit(200);
  const technicians = await listTechnicians(actor);
  const lanes = new Map<string, BoardLane>();
  for (const tech of technicians) lanes.set(tech.id, { technicianId: tech.id, name: tech.name, jobs: [] });
  const unassigned: DispatchJob[] = [];
  for (const job of jobs) {
    if (!job.assigneeId || job.status === "unassigned") {
      unassigned.push(job);
      continue;
    }
    const lane = lanes.get(job.assigneeId) ?? {
      technicianId: job.assigneeId,
      name: job.assigneeName ?? "Technician",
      jobs: [],
    };
    lane.jobs.push(job);
    lanes.set(job.assigneeId, lane);
  }
  return { date, unassigned, lanes: [...lanes.values()], truncated: jobs.length >= 200 };
}

async function existingJob(tx: Pick<ReturnType<typeof db>, "select">, actorId: string, clientOpId: string) {
  const [row] = await tx
    .select({ id: schema.serviceJob.id })
    .from(schema.serviceJob)
    .where(and(eq(schema.serviceJob.createdBy, actorId), eq(schema.serviceJob.clientOpId, clientOpId)))
    .limit(1);
  return row?.id;
}

export async function createDispatchJob(actor: Actor, input: unknown): Promise<DispatchJob> {
  assertDispatcher(actor);
  const data = createDispatchJobInput.parse(input);
  const start = data.scheduledStart ? parseUtcInstant(data.scheduledStart) : null;
  const end = data.scheduledEnd ? parseUtcInstant(data.scheduledEnd) : null;

  const id = await db().transaction(async (tx) => {
    const replay = await existingJob(tx, actor.id, data.clientOpId);
    if (replay) return replay;

    await consumeRate(tx, actor.id, "api_write", DISPATCH_WRITE_LIMIT, "Too many jobs saved this hour. Try again later.");
    // A parallel retry can pass the check above, then lose the insert race. Refund the extra attempt.
    const raced = await existingJob(tx, actor.id, data.clientOpId);
    if (raced) {
      await releaseRate(tx, actor.id, "api_write");
      return raced;
    }

    const [{ n }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.serviceJob)
      .where(inArray(schema.serviceJob.status, [...OPEN_SERVICE_JOB_STATUSES]));
    if (Number(n) >= OPEN_JOB_CAP) {
      throw new ConflictError("The schedule is full (2,000 open jobs). Complete or cancel one first.");
    }

    const customerId = await resolveCustomer(tx, actor.id, data);
    const siteId = await resolveSite(tx, customerId, data);

    let assigneeId: string | null = null;
    if (data.assigneeId) {
      const [tech] = await tx
        .select({ id: schema.user.id, role: schema.user.role })
        .from(schema.user)
        .where(eq(schema.user.id, data.assigneeId))
        .limit(1);
      if (!tech || tech.role !== "technician") throw new BadRequestError("Choose a technician.");
      assigneeId = tech.id;
    }

    const [inserted] = await tx
      .insert(schema.serviceJob)
      .values({
        customerId,
        siteId,
        createdBy: actor.id,
        assigneeId,
        title: data.title,
        description: data.description,
        priority: data.priority,
        status: assigneeId ? "scheduled" : "unassigned",
        scheduledStart: assigneeId ? start : null,
        scheduledEnd: assigneeId ? end : null,
        clientOpId: data.clientOpId,
      })
      .onConflictDoNothing({ target: [schema.serviceJob.createdBy, schema.serviceJob.clientOpId] })
      .returning({ id: schema.serviceJob.id });
    if (inserted) return inserted.id;
    const again = await existingJob(tx, actor.id, data.clientOpId);
    if (!again) throw new ConflictError("That job could not be saved. Try again.");
    return again;
  });

  const [job] = await jobQuery().where(eq(schema.serviceJob.id, id)).limit(1);
  if (!job) throw new NotFoundError();
  return job;
}

type Tx = Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0];

async function resolveCustomer(tx: Tx, actorId: string, data: CreateDispatchJobInput): Promise<string> {
  if (data.customerId) {
    const [row] = await tx.select({ id: schema.customer.id }).from(schema.customer).where(eq(schema.customer.id, data.customerId)).limit(1);
    if (!row) throw new BadRequestError("Choose a customer.");
    return row.id;
  }
  const customer = data.customer!;
  const [inserted] = await tx
    .insert(schema.customer)
    .values({
      createdBy: actorId,
      name: customer.name,
      phone: customer.phone,
      email: customer.email || null,
      notes: customer.notes,
      clientOpId: customer.clientOpId,
    })
    .onConflictDoNothing({ target: [schema.customer.createdBy, schema.customer.clientOpId] })
    .returning({ id: schema.customer.id });
  if (inserted) return inserted.id;
  const [existing] = await tx
    .select({ id: schema.customer.id })
    .from(schema.customer)
    .where(and(eq(schema.customer.createdBy, actorId), eq(schema.customer.clientOpId, customer.clientOpId)))
    .limit(1);
  if (!existing) throw new ConflictError("That customer could not be saved. Try again.");
  return existing.id;
}

async function resolveSite(tx: Tx, customerId: string, data: CreateDispatchJobInput): Promise<string> {
  if (data.siteId) {
    const [row] = await tx
      .select({ id: schema.site.id, customerId: schema.site.customerId })
      .from(schema.site)
      .where(eq(schema.site.id, data.siteId))
      .limit(1);
    if (!row || row.customerId !== customerId) throw new BadRequestError("Choose a site for this customer.");
    return row.id;
  }
  const site = data.site!;
  const [inserted] = await tx
    .insert(schema.site)
    .values({
      customerId,
      label: site.label,
      address: site.address,
      accessNotes: site.accessNotes,
      clientOpId: site.clientOpId,
    })
    .onConflictDoNothing({ target: [schema.site.customerId, schema.site.clientOpId] })
    .returning({ id: schema.site.id });
  if (inserted) return inserted.id;
  const [existing] = await tx
    .select({ id: schema.site.id })
    .from(schema.site)
    .where(and(eq(schema.site.customerId, customerId), eq(schema.site.clientOpId, site.clientOpId)))
    .limit(1);
  if (!existing) throw new ConflictError("That site could not be saved. Try again.");
  return existing.id;
}
