import "server-only";
import { createHash } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { type Actor, ForbiddenError } from "@/lib/auth/rbac";
import { checkInView, roundCoord } from "@/lib/check-in";
import { db, schema } from "@/lib/db";
import { log } from "@/lib/log";
import { text } from "@/lib/text";
import { transitionAllowed, type SyncResult, type TechJob, type TechNote } from "@/lib/tech-view";
import { consumeRate } from "@/lib/usage";

const SNAPSHOT_LIMIT = 120;
const SYNC_LIMIT = 30;
const SYNC_BUDGET_MS = 8_000;
const NOTE_CAP = 200;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const LATE_MS = 10 * 60 * 1000;
const RESULT_LIMIT = 2_000;

const locationSchema = z.object({
  lat: z.number().gte(-90).lte(90),
  lng: z.number().gte(-180).lte(180),
  accuracyM: z.number().gte(0).lte(10_000),
  capturedAt: z.string().min(1).max(40),
});

const noteOpSchema = z.object({
  opId: z.string().uuid(),
  kind: z.literal("note.add"),
  jobId: z.string().uuid(),
  body: text(2000, { min: 1 }),
  clientAt: z.string().min(1).max(40),
});

const statusOpSchema = z.object({
  opId: z.string().uuid(),
  kind: z.literal("status.set"),
  jobId: z.string().uuid(),
  to: z.enum(["en_route", "on_site", "on_hold", "completed"]),
  baseStatusVersion: z.number().int().positive(),
  dependsOn: z.string().uuid().nullable(),
  clientAt: z.string().min(1).max(40),
  location: locationSchema.optional(),
});

const syncBodySchema = z.object({
  deviceId: text(80).nullable().optional(),
  ops: z.array(z.union([noteOpSchema, statusOpSchema])).max(50),
});

type SyncOp = z.infer<typeof noteOpSchema> | z.infer<typeof statusOpSchema>;
type CompactJob = { id: string; status: string; statusVersion: number; version: number };

export type SyncResponse = { results: SyncResult[]; serverTime: string };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function payloadHash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

/** Client clocks are informational. Anything outside a week of server time is stored as server time and flagged late. */
function clampInstant(raw: string, serverNow: Date): { at: Date; late: boolean } {
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return { at: serverNow, late: true };
  const delta = parsed.getTime() - serverNow.getTime();
  if (Math.abs(delta) > WEEK_MS) return { at: serverNow, late: true };
  return { at: parsed, late: Math.abs(delta) > LATE_MS };
}

function num(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function requireTechnician(actor: Actor): void {
  if (actor.role !== "technician") throw new ForbiddenError();
}

type SnapshotBody = { userId: string; serverTime: string; jobs: TechJob[] };

export async function loadSnapshot(actor: Actor): Promise<{ body: SnapshotBody; etag: string }> {
  requireTechnician(actor);
  await db().transaction(async (tx) => {
    await consumeRate(tx, actor.id, "snapshot", SNAPSHOT_LIMIT, "Too many refreshes. Try again in a little while.");
  });

  const { serviceJob, customer, site, jobNote, jobEvent } = schema;
  const rows = await db()
    .select({
      id: serviceJob.id,
      number: serviceJob.number,
      title: serviceJob.title,
      description: serviceJob.description,
      priority: serviceJob.priority,
      status: serviceJob.status,
      statusVersion: serviceJob.statusVersion,
      version: serviceJob.version,
      scheduledStart: serviceJob.scheduledStart,
      scheduledEnd: serviceJob.scheduledEnd,
      completedAt: serviceJob.completedAt,
      customerName: customer.name,
      customerPhone: customer.phone,
      siteLabel: site.label,
      siteAddress: site.address,
      accessNotes: site.accessNotes,
      siteLat: site.lat,
      siteLng: site.lng,
    })
    .from(serviceJob)
    .innerJoin(customer, eq(customer.id, serviceJob.customerId))
    .innerJoin(site, eq(site.id, serviceJob.siteId))
    .where(
      and(
        eq(serviceJob.assigneeId, actor.id),
        sql`(
          ${serviceJob.status} in ('en_route', 'on_site', 'on_hold')
          or (${serviceJob.status} = 'scheduled' and (${serviceJob.scheduledStart} is null or ${serviceJob.scheduledStart} <= now() + interval '14 days'))
          or (${serviceJob.status} = 'completed' and ${serviceJob.completedAt} > now() - interval '3 days')
        )`,
      ),
    )
    .orderBy(sql`${serviceJob.scheduledStart} asc nulls last`)
    .limit(50);

  const ids = rows.map((row) => row.id);
  const noteRows = ids.length
    ? await db()
        .select({
          id: jobNote.id,
          jobId: jobNote.jobId,
          body: jobNote.body,
          clientAt: jobNote.clientAt,
          serverAt: jobNote.serverAt,
        })
        .from(jobNote)
        .where(inArray(jobNote.jobId, ids))
        .orderBy(desc(jobNote.serverAt))
    : [];
  const eventRows = ids.length
    ? await db()
        .select({
          jobId: jobEvent.jobId,
          lat: jobEvent.lat,
          lng: jobEvent.lng,
          accuracyM: jobEvent.accuracyM,
          late: jobEvent.late,
          serverAt: jobEvent.serverAt,
        })
        .from(jobEvent)
        .where(and(inArray(jobEvent.jobId, ids), sql`${jobEvent.lat} is not null`))
        .orderBy(desc(jobEvent.serverAt))
    : [];

  const notesByJob = new Map<string, TechNote[]>();
  for (const note of noteRows) {
    const list = notesByJob.get(note.jobId) ?? [];
    if (list.length >= 20) continue;
    list.push({ id: note.id, body: note.body, clientAt: iso(note.clientAt) ?? iso(note.serverAt) ?? new Date(0).toISOString() });
    notesByJob.set(note.jobId, list);
  }
  for (const list of notesByJob.values()) list.reverse();

  const checkInByJob = new Map<string, TechJob["checkIn"]>();
  for (const event of eventRows) {
    if (checkInByJob.has(event.jobId)) continue;
    const row = rows.find((item) => item.id === event.jobId);
    checkInByJob.set(
      event.jobId,
      checkInView({
        lat: num(event.lat),
        lng: num(event.lng),
        accuracyM: event.accuracyM,
        late: event.late,
        siteLat: num(row?.siteLat),
        siteLng: num(row?.siteLng),
      }),
    );
  }

  const serverNow = new Date();
  let jobs: TechJob[] = rows.map((row) => ({
    id: row.id,
    number: row.number,
    title: row.title,
    description: row.description,
    priority: row.priority,
    status: row.status,
    statusVersion: row.statusVersion,
    version: row.version,
    scheduledStart: iso(row.scheduledStart),
    scheduledEnd: iso(row.scheduledEnd),
    completedAt: iso(row.completedAt),
    customerName: row.customerName,
    customerPhone: row.customerPhone,
    siteLabel: row.siteLabel,
    siteAddress: row.siteAddress,
    accessNotes: row.accessNotes,
    siteLat: num(row.siteLat),
    siteLng: num(row.siteLng),
    notes: notesByJob.get(row.id) ?? [],
    checkIn: checkInByJob.get(row.id) ?? null,
  }));

  let body: SnapshotBody = { userId: actor.id, serverTime: serverNow.toISOString(), jobs };
  // The snapshot stays under 256 KB. Notes are the only field we can drop without hiding a job.
  while (Buffer.byteLength(JSON.stringify(body)) > 256 * 1024) {
    const withNotes = jobs.find((job) => job.notes.length > 0);
    if (!withNotes) break;
    jobs = jobs.map((job) => (job.id === withNotes.id ? { ...job, notes: job.notes.slice(1) } : job));
    body = { ...body, jobs };
  }

  // serverTime changes every response. The tag covers the jobs, so an unchanged list is a 304.
  const etag = `"${createHash("sha256").update(JSON.stringify({ userId: actor.id, jobs: body.jobs })).digest("hex")}"`;
  return { body, etag };
}

type StoredResult = { job?: CompactJob | null };

export async function applySync(actor: Actor, input: unknown, opts: { budgetMs?: number; now?: () => Date; clockMs?: () => number } = {}): Promise<SyncResponse> {
  requireTechnician(actor);
  const data = syncBodySchema.parse(input);
  const budgetMs = opts.budgetMs ?? SYNC_BUDGET_MS;
  const now = opts.now ?? (() => new Date());
  const clockMs = opts.clockMs ?? (() => Date.now());
  const deviceId = data.deviceId ?? null;

  await db().execute(sql`delete from sync_op where received_at < now() - interval '30 days'`);
  await db().transaction(async (tx) => {
    await consumeRate(tx, actor.id, "sync", SYNC_LIMIT, "Too many syncs. Try again in a little while.");
  });

  const started = clockMs();
  const results: SyncResult[] = [];
  const counts = { applied: 0, replayed: 0, conflict: 0, rejected: 0, deferred: 0 };

  for (const op of data.ops) {
    if (results.length > 0 && clockMs() - started > budgetMs) {
      results.push({ opId: op.opId, outcome: "deferred" });
      counts.deferred += 1;
      continue;
    }
    const result = await applyOne(actor, op, deviceId, now());
    results.push(result);
    counts[result.outcome] += 1;
  }

  log.info("sync.batch", { ops: data.ops.length, ...counts });
  return { results, serverTime: now().toISOString() };
}

async function applyOne(actor: Actor, op: SyncOp, deviceId: string | null, serverNow: Date): Promise<SyncResult> {
  const hash = payloadHash(op);
  const { syncOp, serviceJob, jobNote, jobEvent } = schema;

  return db().transaction(async (tx) => {
    const inserted = await tx
      .insert(syncOp)
      .values({
        actorId: actor.id,
        opId: op.opId,
        deviceId,
        kind: op.kind,
        jobId: op.jobId,
        payloadHash: hash,
        outcome: "rejected",
        code: "pending",
        result: {},
      })
      .onConflictDoNothing()
      .returning({ opId: syncOp.opId });

    if (inserted.length === 0) {
      const [existing] = await tx
        .select()
        .from(syncOp)
        .where(and(eq(syncOp.actorId, actor.id), eq(syncOp.opId, op.opId)));
      if (!existing) return { opId: op.opId, outcome: "rejected", code: "op_id_reused" };
      if (existing.payloadHash !== hash) return { opId: op.opId, outcome: "rejected", code: "op_id_reused" };
      const stored = (existing.result ?? {}) as StoredResult;
      return { opId: op.opId, outcome: "replayed", code: existing.code === "pending" ? null : existing.code, job: stored.job ?? null };
    }

    const [job] = await tx.select().from(serviceJob).where(eq(serviceJob.id, op.jobId)).for("update");
    const assigned = Boolean(job && job.assigneeId === actor.id);

    const finish = async (outcome: "applied" | "conflict" | "rejected", code: string | null, compact: CompactJob | null): Promise<SyncResult> => {
      const result: StoredResult = compact ? { job: compact } : {};
      const encoded = JSON.stringify(result);
      const stored = encoded.length <= RESULT_LIMIT ? result : {};
      await tx
        .update(syncOp)
        .set({ outcome, code, result: stored })
        .where(and(eq(syncOp.actorId, actor.id), eq(syncOp.opId, op.opId)));
      return { opId: op.opId, outcome, code, job: compact };
    };

    // Missing and unassigned look the same for a note. A status op is a conflict with no job body,
    // so a guessed id still can't be told apart from a job that was taken off this technician.
    if (!assigned || !job) {
      if (op.kind === "note.add") return finish("rejected", "not_assigned", null);
      return finish("conflict", "not_assigned", null);
    }

    const clientAt = clampInstant(op.clientAt, serverNow).at;

    if (op.kind === "note.add") {
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(jobNote).where(eq(jobNote.jobId, job.id));
      if (Number(n) >= NOTE_CAP) return finish("rejected", "too_many_notes", null);
      await tx.insert(jobNote).values({
        jobId: job.id,
        authorId: actor.id,
        body: op.body,
        clientAt,
        opId: op.opId,
      });
      const version = job.version + 1;
      await tx
        .update(serviceJob)
        .set({ version, updatedAt: serverNow })
        .where(eq(serviceJob.id, job.id));
      return finish("applied", null, { id: job.id, status: job.status, statusVersion: job.statusVersion, version });
    }

    if (op.location && op.to !== "on_site") return finish("rejected", "location_not_allowed", null);

    if (op.dependsOn) {
      const [prior] = await tx
        .select({ outcome: syncOp.outcome })
        .from(syncOp)
        .where(and(eq(syncOp.actorId, actor.id), eq(syncOp.opId, op.dependsOn)));
      if (!prior || prior.outcome !== "applied") {
        return finish("conflict", "depends_on", { id: job.id, status: job.status, statusVersion: job.statusVersion, version: job.version });
      }
    }

    if (job.statusVersion !== op.baseStatusVersion) {
      return finish("conflict", "stale_version", { id: job.id, status: job.status, statusVersion: job.statusVersion, version: job.version });
    }

    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(jobNote).where(eq(jobNote.jobId, job.id));
    const rule = transitionAllowed(job.status, op.to, Number(n));
    if (!rule.ok) {
      return finish(rule.noteRequired ? "rejected" : "conflict", rule.noteRequired ? "note_required" : "bad_transition", {
        id: job.id,
        status: job.status,
        statusVersion: job.statusVersion,
        version: job.version,
      });
    }

    let lat: string | null = null;
    let lng: string | null = null;
    let accuracyM: number | null = null;
    let capturedAt: Date | null = null;
    let late = false;
    if (op.to === "on_site" && op.location) {
      lat = roundCoord(op.location.lat).toFixed(4);
      lng = roundCoord(op.location.lng).toFixed(4);
      accuracyM = Math.round(op.location.accuracyM);
      const captured = clampInstant(op.location.capturedAt, serverNow);
      capturedAt = captured.at;
      late = captured.late;
    }

    const statusVersion = job.statusVersion + 1;
    const version = job.version + 1;
    await tx
      .update(serviceJob)
      .set({
        status: op.to,
        statusVersion,
        version,
        completedAt: op.to === "completed" ? serverNow : job.completedAt,
        updatedAt: serverNow,
      })
      .where(eq(serviceJob.id, job.id));
    await tx.insert(jobEvent).values({
      jobId: job.id,
      actorId: actor.id,
      kind: "status",
      fromStatus: job.status,
      toStatus: op.to,
      lat,
      lng,
      accuracyM,
      capturedAt,
      late,
      clientAt,
      opId: op.opId,
    });
    return finish("applied", null, { id: job.id, status: op.to, statusVersion, version });
  });
}
