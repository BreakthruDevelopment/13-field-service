import { sql } from "drizzle-orm";
import { boolean, check, date, foreignKey, index, integer, jsonb, numeric, pgTable, primaryKey, serial, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Auth tables (shape required by Better Auth with the admin plugin).
// ---------------------------------------------------------------------------

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  role: text("role").notNull().default("user"),
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    impersonatedBy: text("impersonated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Example domain table. Each app replaces this with its own entities, keeping
// the ownerId pattern so per-user access control stays enforceable in SQL.
// ---------------------------------------------------------------------------

export const item = pgTable(
  "item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    /** Set by clients that retry (see src/lib/client-op.ts); unique per owner, so a replay returns the first row. */
    clientOpId: uuid("client_op_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("item_owner_id_idx").on(t.ownerId), uniqueIndex("item_owner_client_op_uidx").on(t.ownerId, t.clientOpId)],
);

// ---------------------------------------------------------------------------
// Usage limits (src/lib/usage.ts). Each app lists its own kinds here; changing a list
// needs a migration, because the CHECK constraints below are part of the schema.
// ---------------------------------------------------------------------------

export const RATE_KINDS = ["api_write", "ai", "upload", "sync", "snapshot"] as const;
export const DAILY_USAGE_KINDS = ["ai", "demo_load"] as const;

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));

/** App-wide daily counters (one row per UTC day and kind) for free-tier caps. */
export const dailyUsage = pgTable(
  "daily_usage",
  {
    day: date("day", { mode: "string" }).notNull(),
    kind: text("kind", { enum: DAILY_USAGE_KINDS }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.day, t.kind] }),
    check("daily_usage_kind_chk", sql`${t.kind} in (${list(DAILY_USAGE_KINDS)})`),
    check("daily_usage_count_chk", sql`${t.count} >= 0`),
  ],
);

/** Per-user rate-limit ledger: one row per attempt, counted over a sliding window. */
export const rateEvent = pgTable(
  "rate_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: RATE_KINDS }).notNull(),
    at: timestamp("at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    index("rate_event_user_kind_at_idx").on(t.userId, t.kind, t.at),
    check("rate_event_kind_chk", sql`${t.kind} in (${list(RATE_KINDS)})`),
  ],
);

export const JOB_STATUSES = ["queued", "running", "done", "failed"] as const;

/**
 * Background job queue (see src/lib/jobs). `key` makes enqueue idempotent: only one queued or running job per
 * (kind, key). `payload` holds ids and small parameters, never personal data or secrets. `last_error` is a short
 * code, never a message.
 */
export const job = pgTable(
  "job",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    key: text("key"),
    ownerId: text("owner_id").references(() => user.id, { onDelete: "cascade" }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status", { enum: JOB_STATUSES }).notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(4),
    /** Times a handler asked to try again later without using an attempt; capped so a job can't defer forever. */
    deferrals: integer("deferrals").notNull().default(0),
    /** A floor, not a deadline: the job runs at the first claim after this time. */
    runAfter: timestamp("run_after", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    /** While running: the lease. After it passes, any worker may reclaim the job. */
    lockedUntil: timestamp("locked_until", { withTimezone: true, precision: 3 }),
    /** Fencing token of the current claim: a worker whose lease was reclaimed can no longer complete or fail the job. */
    lockToken: uuid("lock_token"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true, precision: 3 }),
  },
  (t) => [
    uniqueIndex("job_active_key_uidx").on(t.kind, t.key).where(sql`${t.status} in ('queued', 'running') and ${t.key} is not null`),
    index("job_due_idx").on(t.runAfter).where(sql`${t.status} = 'queued'`),
    index("job_lease_idx").on(t.lockedUntil).where(sql`${t.status} = 'running'`),
    index("job_kind_key_idx").on(t.kind, t.key, t.createdAt),
    index("job_owner_idx").on(t.ownerId),
    check("job_status_chk", sql`${t.status} in (${list(JOB_STATUSES)})`),
    check("job_attempts_chk", sql`${t.attempts} >= 0 and ${t.maxAttempts} >= 1 and ${t.deferrals} >= 0`),
  ],
);

// ---------------------------------------------------------------------------
// Field service. The queue table above is already named `job`, so a visit is a
// `service_job`. Technicians only ever see rows assigned to them.
// ---------------------------------------------------------------------------

export const JOB_PRIORITIES = ["low", "normal", "high", "emergency"] as const;
export type JobPriority = (typeof JOB_PRIORITIES)[number];

export const SERVICE_JOB_STATUSES = ["unassigned", "scheduled", "en_route", "on_site", "on_hold", "completed", "cancelled"] as const;
export type ServiceJobStatus = (typeof SERVICE_JOB_STATUSES)[number];

export const customer = pgTable(
  "customer",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    phone: text("phone").notNull().default(""),
    email: text("email"),
    notes: text("notes").notNull().default(""),
    clientOpId: uuid("client_op_id"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("customer_created_by_client_op_uidx").on(t.createdBy, t.clientOpId),
    index("customer_name_idx").on(t.name),
    check("customer_version_chk", sql`${t.version} >= 1`),
  ],
);

export const site = pgTable(
  "site",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customer.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    address: text("address").notNull(),
    lat: numeric("lat", { precision: 8, scale: 5 }),
    lng: numeric("lng", { precision: 8, scale: 5 }),
    accessNotes: text("access_notes").notNull().default(""),
    clientOpId: uuid("client_op_id"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("site_id_customer_uidx").on(t.id, t.customerId),
    uniqueIndex("site_customer_client_op_uidx").on(t.customerId, t.clientOpId),
    index("site_customer_id_idx").on(t.customerId),
    check("site_version_chk", sql`${t.version} >= 1`),
    check("site_coords_chk", sql`(${t.lat} is null and ${t.lng} is null) or (${t.lat} is not null and ${t.lng} is not null)`),
  ],
);

export const serviceJob = pgTable(
  "service_job",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: serial("number").notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customer.id, { onDelete: "cascade" }),
    siteId: uuid("site_id").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    assigneeId: text("assignee_id").references(() => user.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    priority: text("priority", { enum: JOB_PRIORITIES }).notNull().default("normal"),
    status: text("status", { enum: SERVICE_JOB_STATUSES }).notNull().default("unassigned"),
    scheduledStart: timestamp("scheduled_start", { withTimezone: true, precision: 3 }),
    scheduledEnd: timestamp("scheduled_end", { withTimezone: true, precision: 3 }),
    version: integer("version").notNull().default(1),
    statusVersion: integer("status_version").notNull().default(1),
    clientOpId: uuid("client_op_id"),
    completedAt: timestamp("completed_at", { withTimezone: true, precision: 3 }),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("service_job_number_uidx").on(t.number),
    uniqueIndex("service_job_created_by_client_op_uidx").on(t.createdBy, t.clientOpId),
    index("service_job_assignee_status_start_idx").on(t.assigneeId, t.status, t.scheduledStart),
    index("service_job_scheduled_start_idx").on(t.scheduledStart),
    index("service_job_customer_id_idx").on(t.customerId),
    foreignKey({
      columns: [t.siteId, t.customerId],
      foreignColumns: [site.id, site.customerId],
      name: "service_job_site_customer_fk",
    }).onDelete("cascade"),
    check("service_job_priority_chk", sql`${t.priority} in (${list(JOB_PRIORITIES)})`),
    check("service_job_status_chk", sql`${t.status} in (${list(SERVICE_JOB_STATUSES)})`),
    check("service_job_version_chk", sql`${t.version} >= 1 and ${t.statusVersion} >= 1`),
    check(
      "service_job_window_chk",
      sql`((${t.scheduledStart} is null and ${t.scheduledEnd} is null) or (${t.scheduledEnd} > ${t.scheduledStart} and ${t.scheduledEnd} <= ${t.scheduledStart} + interval '12 hours'))`,
    ),
  ],
);

export const JOB_NOTE_MAX = 200;

export const jobNote = pgTable(
  "job_note",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => serviceJob.id, { onDelete: "cascade" }),
    authorId: text("author_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    body: text("body").notNull(),
    clientAt: timestamp("client_at", { withTimezone: true, precision: 3 }).notNull(),
    serverAt: timestamp("server_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    opId: uuid("op_id").notNull(),
  },
  (t) => [uniqueIndex("job_note_author_op_uidx").on(t.authorId, t.opId), index("job_note_job_id_idx").on(t.jobId, t.serverAt)],
);

export const JOB_EVENT_KINDS = ["created", "assigned", "unassigned", "rescheduled", "status"] as const;

export const jobEvent = pgTable(
  "job_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => serviceJob.id, { onDelete: "cascade" }),
    actorId: text("actor_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    kind: text("kind", { enum: JOB_EVENT_KINDS }).notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    lat: numeric("lat", { precision: 7, scale: 4 }),
    lng: numeric("lng", { precision: 7, scale: 4 }),
    accuracyM: integer("accuracy_m"),
    capturedAt: timestamp("captured_at", { withTimezone: true, precision: 3 }),
    late: boolean("late").notNull().default(false),
    clientAt: timestamp("client_at", { withTimezone: true, precision: 3 }),
    serverAt: timestamp("server_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    opId: uuid("op_id"),
  },
  (t) => [
    index("job_event_job_id_idx").on(t.jobId, t.serverAt),
    check("job_event_kind_chk", sql`${t.kind} in (${list(JOB_EVENT_KINDS)})`),
    check(
      "job_event_location_chk",
      sql`((${t.lat} is null and ${t.lng} is null) or (${t.toStatus} = 'on_site' and ${t.lat} is not null and ${t.lng} is not null))`,
    ),
  ],
);

export const SYNC_OUTCOMES = ["applied", "conflict", "rejected"] as const;

/** Replay ledger. One row per (technician, op id). The payload is not stored, only its hash. */
export const syncOp = pgTable(
  "sync_op",
  {
    actorId: text("actor_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    opId: uuid("op_id").notNull(),
    deviceId: text("device_id"),
    kind: text("kind").notNull(),
    jobId: uuid("job_id").notNull(),
    payloadHash: text("payload_hash").notNull(),
    outcome: text("outcome", { enum: SYNC_OUTCOMES }).notNull(),
    code: text("code"),
    result: jsonb("result").$type<Record<string, unknown>>().notNull().default({}),
    receivedAt: timestamp("received_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.actorId, t.opId] }),
    index("sync_op_received_idx").on(t.receivedAt),
    check("sync_op_outcome_chk", sql`${t.outcome} in (${list(SYNC_OUTCOMES)})`),
    check("sync_op_kind_chk", sql`${t.kind} in ('note.add', 'status.set')`),
  ],
);

export const WORK_ORDER_STATUSES = ["draft", "submitted", "approved", "returned"] as const;
export type WorkOrderStatus = (typeof WORK_ORDER_STATUSES)[number];

export const workOrder = pgTable(
  "work_order",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => serviceJob.id, { onDelete: "cascade" }),
    status: text("status", { enum: WORK_ORDER_STATUSES }).notNull().default("draft"),
    summary: text("summary").notNull().default(""),
    tasks: jsonb("tasks").$type<{ description: string; state: "done" | "to_do" }[]>().notNull().default([]),
    followUp: text("follow_up").notNull().default(""),
    returnReason: text("return_reason"),
    submittedBy: text("submitted_by").references(() => user.id, { onDelete: "set null" }),
    approvedBy: text("approved_by").references(() => user.id, { onDelete: "set null" }),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("work_order_job_uidx").on(t.jobId),
    check("work_order_status_chk", sql`${t.status} in (${list(WORK_ORDER_STATUSES)})`),
    check("work_order_version_chk", sql`${t.version} >= 1`),
  ],
);

export const PART_UNITS = ["each", "ft", "m", "box", "roll", "l", "kg", "set"] as const;
export type PartUnit = (typeof PART_UNITS)[number];

export const workOrderLine = pgTable(
  "work_order_line",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workOrderId: uuid("work_order_id")
      .notNull()
      .references(() => workOrder.id, { onDelete: "cascade" }),
    mentioned: text("mentioned").notNull(),
    qty: numeric("qty", { precision: 10, scale: 2 }).notNull(),
    unit: text("unit", { enum: PART_UNITS }).notNull(),
    used: text("used", { enum: ["used", "needed"] }).notNull(),
    source: text("source", { enum: ["ai", "human"] }).notNull().default("human"),
    position: integer("position").notNull(),
  },
  (t) => [
    index("work_order_line_order_idx").on(t.workOrderId, t.position),
    check("work_order_line_unit_chk", sql`${t.unit} in (${list(PART_UNITS)})`),
    check("work_order_line_used_chk", sql`${t.used} in ('used', 'needed')`),
    check("work_order_line_source_chk", sql`${t.source} in ('ai', 'human')`),
    check("work_order_line_qty_chk", sql`${t.qty} > 0`),
  ],
);

export type User = typeof user.$inferSelect;
export type Item = typeof item.$inferSelect;
export type Job = typeof job.$inferSelect;
