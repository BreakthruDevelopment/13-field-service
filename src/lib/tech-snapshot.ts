import "server-only";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import { assertCan, jobScope } from "@/lib/access";
import { assertActorCurrent } from "@/lib/actor-current";
import type { Actor } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { type JobStatus } from "@/lib/job-status";
import { consumeRate } from "@/lib/usage";

/**
 * GET /api/my/jobs (13.2): everything the technician's phone keeps offline. The actor's own jobs only (`jobScope`):
 * open ones (a `scheduled` job only when it starts within 14 days; anything already under way always), jobs completed or
 * cancelled in the last 3 days (so a cancel shows up as a cancel, not as a job that quietly vanished), at most 50.
 * Each carries the customer's name and phone, the site address, access notes and coordinates, and the last 20 notes.
 * Never the customer's email or notes, never another technician's data, never the parts catalog.
 * The body is kept under 256 KB: jobs that don't fit are left out, then older notes are dropped. `truncated` is true when
 * any matching job is missing, whether because of the 50-job limit or the byte budget.
 */

export const SNAPSHOT_LIMIT_PER_HOUR = 120;
export const SNAPSHOT_MAX_JOBS = 50;
export const SNAPSHOT_NOTES_PER_JOB = 20;
export const SNAPSHOT_MAX_BYTES = 256 * 1024;
export const SNAPSHOT_SCHEDULE_DAYS = 14;
export const SNAPSHOT_RECENT_DAYS = 3;

const { serviceJob, customer, site, jobNote } = schema;

export type TechNote = { id: string; body: string; clientAt: string | null; serverAt: string; byMe: boolean };

export type TechJob = {
  id: string;
  number: number;
  title: string;
  description: string;
  priority: (typeof schema.JOB_PRIORITIES)[number];
  status: JobStatus;
  version: number;
  statusVersion: number;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  completedAt: string | null;
  customer: { name: string; phone: string };
  site: { label: string; address: string; accessNotes: string; lat: number | null; lng: number | null };
  /** Oldest first. `notesTruncated` when older notes exist that aren't included. */
  notes: TechNote[];
  notesTruncated: boolean;
};

export type TechSnapshot = { userId: string; serverTime: string; jobs: TechJob[]; truncated: boolean };

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const num = (v: string | null) => (v === null ? null : Number(v));
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

/**
 * Fit jobs and notes into `limit` bytes. Jobs go in order until one doesn't fit; then notes, newest first within each job,
 * until the budget is spent. Pure, so it is unit-tested without a database.
 */
export function fitSnapshot(jobs: TechJob[], limit: number = SNAPSHOT_MAX_BYTES, overhead = 512): { jobs: TechJob[]; truncated: boolean } {
  let used = overhead;
  const kept: TechJob[] = [];
  let truncated = false;
  for (const job of jobs) {
    const base = { ...job, notes: [] };
    const size = bytes(base) + 1;
    if (used + size > limit) {
      truncated = true;
      break;
    }
    used += size;
    kept.push(base);
  }
  for (const [i, kept_] of kept.entries()) {
    const source = jobs[i].notes;
    const take: TechNote[] = [];
    for (let n = source.length - 1; n >= 0; n--) {
      const size = bytes(source[n]) + 1;
      if (used + size > limit) break;
      used += size;
      take.unshift(source[n]);
    }
    kept_.notes = take;
    kept_.notesTruncated = jobs[i].notesTruncated || take.length < source.length;
  }
  return { jobs: kept, truncated };
}

export async function loadTechSnapshot(actor: Actor, now: Date = new Date()): Promise<TechSnapshot> {
  assertCan(actor, "read", "sync");
  const day = 24 * 3600_000;
  const horizon = new Date(now.getTime() + SNAPSHOT_SCHEDULE_DAYS * day);
  const recent = new Date(now.getTime() - SNAPSHOT_RECENT_DAYS * day);
  const q = db();
  const allRows = await q
    .select({
      id: serviceJob.id,
      number: serviceJob.number,
      title: serviceJob.title,
      description: serviceJob.description,
      priority: serviceJob.priority,
      status: serviceJob.status,
      version: serviceJob.version,
      statusVersion: serviceJob.statusVersion,
      scheduledStart: serviceJob.scheduledStart,
      scheduledEnd: serviceJob.scheduledEnd,
      completedAt: serviceJob.completedAt,
      customerName: customer.name,
      customerPhone: customer.phone,
      siteLabel: site.label,
      siteAddress: site.address,
      siteAccessNotes: site.accessNotes,
      siteLat: site.lat,
      siteLng: site.lng,
    })
    .from(serviceJob)
    .innerJoin(customer, eq(customer.id, serviceJob.customerId))
    .innerJoin(site, eq(site.id, serviceJob.siteId))
    .where(
      and(
        jobScope(actor),
        or(
          inArray(serviceJob.status, ["en_route", "on_site", "on_hold"]),
          and(eq(serviceJob.status, "scheduled"), or(sql`${serviceJob.scheduledStart} is null`, lte(serviceJob.scheduledStart, horizon))),
          and(eq(serviceJob.status, "completed"), gte(serviceJob.completedAt, recent)),
          and(eq(serviceJob.status, "cancelled"), gte(serviceJob.updatedAt, recent)),
        ),
      ),
    )
    .orderBy(sql`${serviceJob.scheduledStart} asc nulls last`, desc(serviceJob.number))
    // One more than we keep: the extra row only tells us the list is incomplete (`truncated`).
    .limit(SNAPSHOT_MAX_JOBS + 1);
  const overflow = allRows.length > SNAPSHOT_MAX_JOBS;
  const rows = allRows.slice(0, SNAPSHOT_MAX_JOBS);

  const ids = rows.map((r) => r.id);
  const ranked = q
    .select({
      id: jobNote.id,
      jobId: jobNote.jobId,
      authorId: jobNote.authorId,
      body: jobNote.body,
      clientAt: jobNote.clientAt,
      serverAt: jobNote.serverAt,
      rn: sql<number>`row_number() over (partition by ${jobNote.jobId} order by ${jobNote.serverAt} desc, ${jobNote.id} desc)`.as("rn"),
    })
    .from(jobNote)
    .where(inArray(jobNote.jobId, ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]))
    .as("ranked");
  const noteRows = ids.length
    ? await q
        .select()
        .from(ranked)
        .where(lte(ranked.rn, SNAPSHOT_NOTES_PER_JOB + 1))
        .orderBy(asc(ranked.serverAt), asc(ranked.id))
    : [];

  const notesByJob = new Map<string, TechNote[]>();
  const more = new Set<string>();
  for (const n of noteRows) {
    // Oldest first; rank 21 only proves that older notes exist, and isn't sent.
    if (Number(n.rn) > SNAPSHOT_NOTES_PER_JOB) {
      more.add(n.jobId);
      continue;
    }
    const list = notesByJob.get(n.jobId) ?? [];
    list.push({ id: n.id, body: n.body, clientAt: iso(n.clientAt), serverAt: n.serverAt.toISOString(), byMe: n.authorId === actor.id });
    notesByJob.set(n.jobId, list);
  }

  const jobs: TechJob[] = rows.map((r) => ({
    id: r.id,
    number: r.number,
    title: r.title,
    description: r.description,
    priority: r.priority,
    status: r.status,
    version: r.version,
    statusVersion: r.statusVersion,
    scheduledStart: iso(r.scheduledStart),
    scheduledEnd: iso(r.scheduledEnd),
    completedAt: iso(r.completedAt),
    customer: { name: r.customerName, phone: r.customerPhone },
    site: { label: r.siteLabel, address: r.siteAddress, accessNotes: r.siteAccessNotes, lat: num(r.siteLat), lng: num(r.siteLng) },
    notes: notesByJob.get(r.id) ?? [],
    notesTruncated: more.has(r.id),
  }));
  const fit = fitSnapshot(jobs);
  return { userId: actor.id, serverTime: now.toISOString(), jobs: fit.jobs, truncated: fit.truncated || overflow };
}

/** The weak ETag of the content (not `serverTime`, which always changes): equal for equal snapshots of the same user. */
export function snapshotEtag(s: TechSnapshot): string {
  const h = createHash("sha256").update(JSON.stringify([s.userId, s.truncated, s.jobs])).digest("hex").slice(0, 32);
  return `W/"${h}"`;
}

/** Spend one `snapshot` attempt (120 per hour; a 304 costs the same: it still reads the database) and load. */
export async function getTechSnapshot(actor: Actor): Promise<{ snapshot: TechSnapshot; etag: string }> {
  assertCan(actor, "read", "sync");
  await db().transaction(async (tx) => {
    await assertActorCurrent(tx, actor);
    await consumeRate(tx, actor.id, "snapshot", SNAPSHOT_LIMIT_PER_HOUR, "Too many refreshes. Try again in a few minutes.");
  });
  const snapshot = await loadTechSnapshot(actor);
  return { snapshot, etag: snapshotEtag(snapshot) };
}
