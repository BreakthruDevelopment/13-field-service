import { osmUrl } from "@/lib/check-in";
import {
  attentionDetail,
  statusLabel,
  transitionAllowed,
  type AttentionItem,
  type OutboxOp,
  type SyncResult,
  type TechJob,
} from "@/lib/tech-view";

export type LocalState = {
  serverJobs: TechJob[];
  outbox: OutboxOp[];
  attention: AttentionItem[];
  savedAt: string | null;
  ownerId: string | null;
};

export function emptyState(): LocalState {
  return { serverJobs: [], outbox: [], attention: [], savedAt: null, ownerId: null };
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Drop a snapshot that belongs to someone else or is older than the session. */
export function shouldWipeSnapshot(state: LocalState, sessionUserId: string, now: Date): boolean {
  if (state.ownerId && state.ownerId !== sessionUserId) return true;
  if (!state.savedAt) return false;
  const saved = new Date(state.savedAt).getTime();
  if (Number.isNaN(saved)) return true;
  return now.getTime() - saved > WEEK_MS;
}

function cloneJob(job: TechJob): TechJob {
  return { ...job, notes: job.notes.map((note) => ({ ...note })), checkIn: job.checkIn ? { ...job.checkIn } : null };
}

export function project(state: LocalState): TechJob[] {
  const jobs = state.serverJobs.map(cloneJob);
  for (const op of state.outbox) {
    const job = jobs.find((item) => item.id === op.jobId);
    if (!job) continue;
    if (op.kind === "note.add" && op.body) {
      if (!job.notes.some((note) => note.id === op.opId)) {
        job.notes.push({ id: op.opId, body: op.body, clientAt: op.clientAt, pending: true });
      }
    }
    if (op.kind === "status.set" && op.to) {
      job.status = op.to;
      job.statusVersion += 1;
      if (op.to === "completed") job.completedAt = op.clientAt;
      if (op.location) {
        job.checkIn = {
          summary: "Check-in waiting to sync",
          osmUrl: osmUrl(op.location.lat, op.location.lng),
          deviceReported: true,
        };
      }
    }
  }
  return jobs;
}

function nextSeq(state: LocalState): number {
  return state.outbox.reduce((max, op) => Math.max(max, op.seq), 0) + 1;
}

export function enqueueNote(
  state: LocalState,
  jobId: string,
  body: string,
  opId: string,
  now: Date,
): { state: LocalState; error: string | null } {
  const trimmed = body.trim();
  if (!trimmed) return { state, error: "Write a note first." };
  if (trimmed.length > 2000) return { state, error: "Notes can be at most 2000 characters." };
  if (trimmed.includes("\0")) return { state, error: "Text can't contain null characters." };
  if (!project(state).some((job) => job.id === jobId)) return { state, error: "That job isn't on this phone." };
  const op: OutboxOp = { seq: nextSeq(state), opId, kind: "note.add", jobId, body: trimmed, clientAt: now.toISOString() };
  return { state: { ...state, outbox: [...state.outbox, op] }, error: null };
}

export function enqueueStatus(
  state: LocalState,
  jobId: string,
  to: string,
  opId: string,
  now: Date,
  location?: OutboxOp["location"],
): { state: LocalState; error: string | null } {
  const job = project(state).find((item) => item.id === jobId);
  if (!job) return { state, error: "That job isn't on this phone." };
  const rule = transitionAllowed(job.status, to, job.notes.length);
  if (!rule.ok) {
    return { state, error: rule.noteRequired ? "Add a note first." : "That status change isn't available." };
  }
  const previous = [...state.outbox].reverse().find((op) => op.kind === "status.set" && op.jobId === jobId);
  const op: OutboxOp = {
    seq: nextSeq(state),
    opId,
    kind: "status.set",
    jobId,
    to,
    baseStatusVersion: job.statusVersion,
    dependsOn: previous?.opId ?? null,
    clientAt: now.toISOString(),
    location: to === "on_site" ? (location ?? null) : null,
  };
  return { state: { ...state, outbox: [...state.outbox, op] }, error: null };
}

export function replaceSnapshot(state: LocalState, jobs: TechJob[], savedAt: string, ownerId: string): LocalState {
  return { ...state, serverJobs: jobs.map(cloneJob), savedAt, ownerId };
}

export function dismissAttention(state: LocalState, id: string): LocalState {
  return { ...state, attention: state.attention.filter((item) => item.id !== id) };
}

function commitOp(jobs: TechJob[], op: OutboxOp, result: SyncResult): TechJob[] {
  return jobs.map((job) => {
    if (job.id !== op.jobId) return job;
    if (op.kind === "note.add" && op.body) {
      const notes = job.notes.filter((note) => note.id !== op.opId);
      notes.push({ id: op.opId, body: op.body, clientAt: op.clientAt });
      return { ...job, notes, version: result.job?.version ?? job.version };
    }
    if (op.kind === "status.set" && op.to) {
      const status = result.job?.status ?? op.to;
      return {
        ...job,
        status,
        statusVersion: result.job?.statusVersion ?? job.statusVersion,
        version: result.job?.version ?? job.version,
        completedAt: status === "completed" ? (job.completedAt ?? op.clientAt) : job.completedAt,
      };
    }
    return job;
  });
}

/** Apply a flush response. Deferred ops stay. Everything else leaves the outbox. Conflicts keep the note text. */
export function applyResults(state: LocalState, results: SyncResult[], now: Date): LocalState {
  let serverJobs = state.serverJobs.map(cloneJob);
  let outbox = [...state.outbox];
  let attention = [...state.attention];
  for (const result of results) {
    if (result.outcome === "deferred") continue;
    const op = outbox.find((item) => item.opId === result.opId);
    outbox = outbox.filter((item) => item.opId !== result.opId);
    if (!op) continue;
    if (result.outcome === "applied" || result.outcome === "replayed") {
      serverJobs = commitOp(serverJobs, op, result);
      continue;
    }
    if (result.code === "not_assigned") {
      serverJobs = serverJobs.filter((job) => job.id !== op.jobId);
    } else if (result.job) {
      serverJobs = serverJobs.map((job) =>
        job.id === result.job!.id
          ? { ...job, status: result.job!.status, statusVersion: result.job!.statusVersion, version: result.job!.version }
          : job,
      );
    }
    attention = [
      {
        id: op.opId,
        jobId: op.jobId,
        kind: op.kind,
        outcome: result.outcome,
        code: result.code ?? null,
        tried: op.kind === "note.add" ? (op.body ?? "") : `Status to ${statusLabel(op.to ?? "")}`,
        detail: attentionDetail(result.code ?? null, op.kind, result.job?.status),
        noteBody: op.kind === "note.add" ? (op.body ?? null) : null,
        at: now.toISOString(),
      },
      ...attention.filter((item) => item.id !== op.opId),
    ];
  }
  return { ...state, serverJobs, outbox, attention };
}

/** Full jitter from 2s, capped at 5 minutes. */
export function nextDelay(attempt: number, random: () => number = Math.random): number {
  const cap = Math.min(5 * 60 * 1000, 2000 * 2 ** Math.max(0, attempt));
  return Math.floor(Math.max(0, Math.min(0.999999, random())) * cap);
}

export function selectBatch(ops: OutboxOp[], maxOps = 50, maxBytes = 64 * 1024): OutboxOp[] {
  const ordered = [...ops].sort((a, b) => a.seq - b.seq);
  const batch: OutboxOp[] = [];
  for (const op of ordered) {
    if (batch.length >= maxOps) break;
    const bytes = new TextEncoder().encode(JSON.stringify({ ops: [...batch, op] })).byteLength;
    if (bytes > maxBytes && batch.length > 0) break;
    batch.push(op);
  }
  return batch;
}

export function classifyResponse(status: number): "ok" | "retry" | "unauthorized" {
  if (status === 401) return "unauthorized";
  if (status === 429 || status >= 500) return "retry";
  if (status >= 200 && status < 300) return "ok";
  return "retry";
}

export function toSyncPayload(op: OutboxOp): Record<string, unknown> {
  if (op.kind === "note.add") {
    return { opId: op.opId, kind: op.kind, jobId: op.jobId, body: op.body, clientAt: op.clientAt };
  }
  return {
    opId: op.opId,
    kind: op.kind,
    jobId: op.jobId,
    to: op.to,
    baseStatusVersion: op.baseStatusVersion,
    dependsOn: op.dependsOn ?? null,
    clientAt: op.clientAt,
    ...(op.location ? { location: op.location } : {}),
  };
}
