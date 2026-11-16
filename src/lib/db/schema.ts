import { sql } from "drizzle-orm";
import { boolean, check, customType, date, foreignKey, index, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";

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
// Field service domain. Every table the data layer reads is listed in specs/13-field-service.md ("Data model").
// The template's background queue keeps the table name `job`, so the work item is `service_job` here.
// User foreign keys are `restrict`: account deletion is out of scope (Better Auth's /admin/remove-user is disabled).
// ---------------------------------------------------------------------------

export const SERVICE_JOB_STATUSES = ["unassigned", "scheduled", "en_route", "on_site", "on_hold", "completed", "cancelled"] as const;
export const JOB_PRIORITIES = ["low", "normal", "high", "emergency"] as const;
export const JOB_EVENT_KINDS = ["created", "assigned", "unassigned", "rescheduled", "status"] as const;
export const PART_UNITS = ["each", "ft", "m", "box", "roll", "l", "kg", "set"] as const;
export const SYNC_OP_KINDS = ["note.add", "status.set"] as const;
export const SYNC_OUTCOMES = ["applied", "conflict", "rejected"] as const;
export const WORK_ORDER_STATUSES = ["draft", "submitted", "approved", "returned"] as const;
export const WORK_ORDER_LINE_USED = ["used", "needed"] as const;
export const WORK_ORDER_LINE_SOURCES = ["ai", "human"] as const;
export const WORK_ORDER_OP_KINDS = ["generate", "edit", "submit", "approve", "return"] as const;

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));

/** Shared by dispatchers (any dispatcher sees every customer); `created_by` only scopes the idempotency key. */
export const customer = pgTable(
  "customer",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    phone: text("phone").notNull(),
    email: text("email"),
    notes: text("notes").notNull().default(""),
    clientOpId: uuid("client_op_id"),
    version: integer("version").notNull().default(1),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("customer_created_by_client_op_uidx").on(t.createdBy, t.clientOpId),
    index("customer_name_idx").on(t.name),
    check("customer_name_len_chk", sql`char_length(${t.name}) between 1 and 120`),
    check("customer_phone_len_chk", sql`char_length(${t.phone}) between 1 and 40`),
    check("customer_email_len_chk", sql`${t.email} is null or char_length(${t.email}) <= 200`),
    check("customer_notes_len_chk", sql`char_length(${t.notes}) <= 1000`),
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
    /** Typed by a dispatcher (no geocoding). Both or neither. */
    lat: numeric("lat", { precision: 8, scale: 5 }),
    lng: numeric("lng", { precision: 8, scale: 5 }),
    accessNotes: text("access_notes").notNull().default(""),
    clientOpId: uuid("client_op_id"),
    version: integer("version").notNull().default(1),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("site_id_customer_uniq").on(t.id, t.customerId),
    uniqueIndex("site_created_by_client_op_uidx").on(t.createdBy, t.clientOpId),
    index("site_customer_idx").on(t.customerId),
    check("site_label_len_chk", sql`char_length(${t.label}) between 1 and 80`),
    check("site_address_len_chk", sql`char_length(${t.address}) between 1 and 300`),
    check("site_access_notes_len_chk", sql`char_length(${t.accessNotes}) <= 500`),
    check("site_coords_chk", sql`(${t.lat} is null) = (${t.lng} is null) and (${t.lat} is null or (${t.lat} between -90 and 90 and ${t.lng} between -180 and 180))`),
  ],
);

export const serviceJob = pgTable(
  "service_job",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: integer("number").notNull().generatedAlwaysAsIdentity(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customer.id, { onDelete: "cascade" }),
    siteId: uuid("site_id").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    priority: text("priority", { enum: JOB_PRIORITIES }).notNull().default("normal"),
    status: text("status", { enum: SERVICE_JOB_STATUSES }).notNull().default("unassigned"),
    scheduledStart: timestamp("scheduled_start", { withTimezone: true }),
    scheduledEnd: timestamp("scheduled_end", { withTimezone: true }),
    /** Bumps on every row change; dispatcher PATCHes carry it (stale: 409). */
    version: integer("version").notNull().default(1),
    /** Bumps only when `status` or `assignee_id` changes, so offline status ops survive a reschedule. */
    statusVersion: integer("status_version").notNull().default(1),
    clientOpId: uuid("client_op_id"),
    /** The technician. Technician access is exactly `assignee_id = actor.id`. */
    assigneeId: text("assignee_id").references(() => user.id, { onDelete: "restrict" }),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.siteId, t.customerId], foreignColumns: [site.id, site.customerId], name: "service_job_site_customer_fk" }),
    uniqueIndex("service_job_created_by_client_op_uidx").on(t.createdBy, t.clientOpId),
    uniqueIndex("service_job_number_uidx").on(t.number),
    index("service_job_assignee_status_start_idx").on(t.assigneeId, t.status, t.scheduledStart),
    index("service_job_scheduled_start_idx").on(t.scheduledStart),
    index("service_job_customer_idx").on(t.customerId),
    index("service_job_status_idx").on(t.status),
    check("service_job_status_chk", sql`${t.status} in (${list(SERVICE_JOB_STATUSES)})`),
    check("service_job_priority_chk", sql`${t.priority} in (${list(JOB_PRIORITIES)})`),
    check("service_job_title_len_chk", sql`char_length(${t.title}) between 1 and 120`),
    check("service_job_description_len_chk", sql`char_length(${t.description}) <= 2000`),
    check(
      "service_job_window_chk",
      sql`(${t.scheduledStart} is null) = (${t.scheduledEnd} is null) and (${t.scheduledStart} is null or (${t.scheduledEnd} > ${t.scheduledStart} and ${t.scheduledEnd} <= ${t.scheduledStart} + interval '12 hours'))`,
    ),
    // Unassigned means no technician; every working or finished state has one; cancelled may or may not; scheduled has a window.
    check("service_job_unassigned_chk", sql`(${t.status} = 'unassigned') = (${t.assigneeId} is null) or ${t.status} = 'cancelled'`),
    check("service_job_scheduled_window_chk", sql`${t.status} <> 'scheduled' or ${t.scheduledStart} is not null`),
  ],
);

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
    clientAt: timestamp("client_at", { withTimezone: true }),
    // clock_timestamp(), not now(): rows written in one transaction must still sort in the order they were written.
    serverAt: timestamp("server_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
    opId: uuid("op_id"),
  },
  (t) => [
    uniqueIndex("job_note_author_op_uidx").on(t.authorId, t.opId),
    index("job_note_job_idx").on(t.jobId, t.serverAt),
    check("job_note_body_len_chk", sql`char_length(${t.body}) between 1 and 2000`),
  ],
);

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
    fromStatus: text("from_status", { enum: SERVICE_JOB_STATUSES }),
    toStatus: text("to_status", { enum: SERVICE_JOB_STATUSES }),
    /** Check-in location, rounded to 4 decimals (about 11 m) by the server; nulled 90 days after the job closes. */
    lat: numeric("lat", { precision: 7, scale: 4 }),
    lng: numeric("lng", { precision: 7, scale: 4 }),
    accuracyM: integer("accuracy_m"),
    capturedAt: timestamp("captured_at", { withTimezone: true }),
    late: boolean("late").notNull().default(false),
    clientAt: timestamp("client_at", { withTimezone: true }),
    // clock_timestamp(), not now(): rows written in one transaction must still sort in the order they were written.
    serverAt: timestamp("server_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
    opId: uuid("op_id"),
  },
  (t) => [
    index("job_event_job_idx").on(t.jobId, t.serverAt),
    index("job_event_located_idx").on(t.jobId).where(sql`${t.lat} is not null`),
    uniqueIndex("job_event_actor_op_uidx").on(t.actorId, t.opId),
    check("job_event_kind_chk", sql`${t.kind} in (${list(JOB_EVENT_KINDS)})`),
    check(
      "job_event_location_chk",
      sql`(${t.lat} is null and ${t.lng} is null and ${t.accuracyM} is null and ${t.capturedAt} is null) or ${t.toStatus} = 'on_site'`,
    ),
    check("job_event_location_pair_chk", sql`(${t.lat} is null) = (${t.lng} is null)`),
  ],
);

/** The replay ledger for POST /api/sync (built in 13.2). Rows are pruned after 30 days. */
export const syncOp = pgTable(
  "sync_op",
  {
    actorId: text("actor_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    opId: uuid("op_id").notNull(),
    deviceId: text("device_id"),
    kind: text("kind", { enum: SYNC_OP_KINDS }).notNull(),
    jobId: uuid("job_id"),
    payloadHash: text("payload_hash").notNull(),
    outcome: text("outcome", { enum: SYNC_OUTCOMES }),
    result: jsonb("result").$type<Record<string, unknown>>(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.actorId, t.opId] }),
    index("sync_op_received_idx").on(t.receivedAt),
    check("sync_op_kind_chk", sql`${t.kind} in (${list(SYNC_OP_KINDS)})`),
    check("sync_op_outcome_chk", sql`${t.outcome} is null or ${t.outcome} in (${list(SYNC_OUTCOMES)})`),
    check("sync_op_result_size_chk", sql`${t.result} is null or octet_length(${t.result}::text) <= 2048`),
  ],
);

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

export const part = pgTable(
  "part",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sku: text("sku").notNull().unique(),
    name: text("name").notNull(),
    unit: text("unit", { enum: PART_UNITS }).notNull().default("each"),
    aliases: text("aliases").array().notNull().default(sql`'{}'::text[]`),
    maxPerJob: integer("max_per_job").notNull().default(20),
    active: boolean("active").notNull().default(true),
    clientOpId: uuid("client_op_id"),
    version: integer("version").notNull().default(1),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // `fs_part_search_text` is an immutable wrapper (array_to_string is only STABLE); it is created in the migration.
    search: tsvector("search").generatedAlwaysAs(sql`to_tsvector('simple', sku || ' ' || name || ' ' || fs_part_search_text(aliases))`),
  },
  (t) => [
    uniqueIndex("part_created_by_client_op_uidx").on(t.createdBy, t.clientOpId),
    index("part_search_idx").using("gin", t.search),
    check("part_sku_chk", sql`${t.sku} ~ '^[A-Z0-9-]{2,40}$'`),
    check("part_name_len_chk", sql`char_length(${t.name}) between 1 and 120`),
    check("part_unit_chk", sql`${t.unit} in (${list(PART_UNITS)})`),
    check("part_aliases_chk", sql`coalesce(array_length(${t.aliases}, 1), 0) <= 10`),
    check("part_max_per_job_chk", sql`${t.maxPerJob} between 1 and 9999`),
  ],
);

/** The tables below are filled by 13.3 (AI work order); they are created here because only wave 1 touches the schema. */
export const workOrder = pgTable(
  "work_order",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .unique()
      .references(() => serviceJob.id, { onDelete: "cascade" }),
    status: text("status", { enum: WORK_ORDER_STATUSES }).notNull().default("draft"),
    summary: text("summary").notNull().default(""),
    tasks: jsonb("tasks").$type<{ description: string; state: "done" | "to_do" }[]>().notNull().default(sql`'[]'::jsonb`),
    followUp: text("follow_up"),
    /** Provider, demo flag, rows dropped by the server checks and why. */
    ai: jsonb("ai").$type<Record<string, unknown>>(),
    returnReason: text("return_reason"),
    submittedBy: text("submitted_by").references(() => user.id, { onDelete: "restrict" }),
    approvedBy: text("approved_by").references(() => user.id, { onDelete: "restrict" }),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("work_order_status_chk", sql`${t.status} in (${list(WORK_ORDER_STATUSES)})`),
    check("work_order_summary_len_chk", sql`char_length(${t.summary}) <= 400`),
    check("work_order_follow_up_len_chk", sql`${t.followUp} is null or char_length(${t.followUp}) <= 300`),
    check("work_order_return_reason_len_chk", sql`${t.returnReason} is null or char_length(${t.returnReason}) <= 300`),
  ],
);

export const workOrderLine = pgTable(
  "work_order_line",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workOrderId: uuid("work_order_id")
      .notNull()
      .references(() => workOrder.id, { onDelete: "cascade" }),
    /** Null means "not in the catalog". */
    partId: uuid("part_id").references(() => part.id, { onDelete: "set null" }),
    mentioned: text("mentioned").notNull(),
    qty: numeric("qty", { precision: 10, scale: 2 }).notNull(),
    unit: text("unit", { enum: PART_UNITS }).notNull(),
    used: text("used", { enum: WORK_ORDER_LINE_USED }).notNull(),
    source: text("source", { enum: WORK_ORDER_LINE_SOURCES }).notNull(),
    flags: text("flags").array().notNull().default(sql`'{}'::text[]`),
    position: integer("position").notNull().default(0),
  },
  (t) => [
    index("work_order_line_order_idx").on(t.workOrderId, t.position),
    check("work_order_line_qty_chk", sql`${t.qty} > 0`),
    check("work_order_line_mentioned_len_chk", sql`char_length(${t.mentioned}) between 1 and 120`),
    check("work_order_line_used_chk", sql`${t.used} in (${list(WORK_ORDER_LINE_USED)})`),
    check("work_order_line_source_chk", sql`${t.source} in (${list(WORK_ORDER_LINE_SOURCES)})`),
  ],
);

/**
 * Replay ledger for the work-order operations (13.3): AI draft, edit, submit, approve, return. The primary key makes a
 * retry with the same `op_id` find the first attempt. `payload_hash` tells a real retry from an id reused for different
 * input. For `generate`, a row with `result` null is a claim: it holds one charge (rate, daily, per-job) while the model
 * runs, and it is deleted again, with the charges refunded, if the draft fails. Its `created_at` is what the per-job
 * daily limit counts; `claimed_at` is the lease a retry waits out before taking over a claim whose request died.
 */
export const workOrderOp = pgTable(
  "work_order_op",
  {
    actorId: text("actor_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    opId: uuid("op_id").notNull(),
    kind: text("kind", { enum: WORK_ORDER_OP_KINDS }).notNull(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => serviceJob.id, { onDelete: "cascade" }),
    payloadHash: text("payload_hash").notNull(),
    /**
     * The `rate_event` this draft was charged to, so a refund returns that very event. Deliberately not a foreign key: the
     * rate limiter prunes aged events, and a cascade from that would lock claim rows in the opposite order to a refund.
     */
    rateEventId: uuid("rate_event_id"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.actorId, t.opId] }),
    index("work_order_op_job_kind_idx").on(t.jobId, t.kind, t.createdAt),
    index("work_order_op_actor_created_idx").on(t.actorId, t.createdAt),
    check("work_order_op_kind_chk", sql`${t.kind} in (${list(WORK_ORDER_OP_KINDS)})`),
    check("work_order_op_result_size_chk", sql`${t.result} is null or octet_length(${t.result}::text) <= 65536`),
  ],
);

// ---------------------------------------------------------------------------
// Usage limits (src/lib/usage.ts). Each app lists its own kinds here; changing a list
// needs a migration, because the CHECK constraints below are part of the schema.
// ---------------------------------------------------------------------------

export const RATE_KINDS = ["api_write", "sync", "sync_replay", "snapshot", "ai", "demo_load", "read"] as const;
export const DAILY_USAGE_KINDS = ["ai", "demo_load"] as const;

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

/** One row per housekeeping task: `ran_at` is the last claim, so the work runs at most once per interval across all instances. */
export const maintenanceRun = pgTable("maintenance_run", {
  name: text("name").primaryKey(),
  ranAt: timestamp("ran_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
});

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

/** Replay ledger for the admin "Load demo" button: a retry with the same `client_op_id` returns the first result and loads nothing. */
export const demoLoadOp = pgTable(
  "demo_load_op",
  {
    adminId: text("admin_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    clientOpId: uuid("client_op_id").notNull(),
    result: jsonb("result").$type<Record<string, number>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.adminId, t.clientOpId] })],
);

/** Replay ledger for POST /api/admin/roles: a retry with the same `client_op_id` returns the first result and changes nothing. */
export const roleChangeOp = pgTable(
  "role_change_op",
  {
    adminId: text("admin_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    clientOpId: uuid("client_op_id").notNull(),
    result: jsonb("result").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.adminId, t.clientOpId] })],
);

export type User = typeof user.$inferSelect;
export type Customer = typeof customer.$inferSelect;
export type Site = typeof site.$inferSelect;
export type ServiceJob = typeof serviceJob.$inferSelect;
export type Part = typeof part.$inferSelect;
export type Job = typeof job.$inferSelect;
