/**
 * Types shared by the offline client (`src/lib/offline/`). Framework-free and free of server imports: this code runs in the
 * browser, so it must never pull in `server-only` modules (the DTO types below are the wire shapes of `/api/my/jobs` and
 * `/api/sync`, repeated here on purpose and checked against the server's by `protocol.test.ts`).
 */
export type JobStatus = "unassigned" | "scheduled" | "en_route" | "on_site" | "on_hold" | "completed" | "cancelled";

export type TechNote = { id: string; body: string; clientAt: string | null; serverAt: string; byMe: boolean; pending?: boolean };

export type TechJob = {
  id: string;
  number: number;
  title: string;
  description: string;
  priority: "low" | "normal" | "high" | "emergency";
  status: JobStatus;
  version: number;
  statusVersion: number;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  completedAt: string | null;
  customer: { name: string; phone: string };
  site: { label: string; address: string; accessNotes: string; lat: number | null; lng: number | null };
  notes: TechNote[];
  notesTruncated: boolean;
  /** Changes queued on this device that the server hasn't confirmed yet. */
  pendingOps?: number;
};

export type Snapshot = { userId: string; serverTime: string; jobs: TechJob[]; truncated: boolean };

/**
 * `rev` counts the times acknowledged ops were folded into this snapshot (see `applyAcknowledged`). A refresh that began
 * before a fold read older state, so it is applied only if the saved `rev` is still the one it started with, in any tab.
 */
export type StoredSnapshot = Snapshot & { savedAt: number; etag: string | null; rev?: number };

export type CheckInLocation = { lat: number; lng: number; accuracyM: number; capturedAt: string };

/** The ops as sent to `POST /api/sync`. */
export type NoteOp = { kind: "note.add"; opId: string; jobId: string; clientAt: string; body: string };
export type StatusOp = {
  kind: "status.set";
  opId: string;
  jobId: string;
  clientAt: string;
  to: JobStatus;
  baseStatusVersion: number;
  dependsOn: string | null;
  location?: CheckInLocation;
};
export type WireOp = NoteOp | StatusOp;

/** An op waiting in the outbox. `seq` is the local order; `label` is for "Needs attention" after the job has gone. */
export type QueuedOp = { seq?: number; op: WireOp; label: string; createdAt: number };

export type SyncOutcome = "applied" | "replayed" | "conflict" | "rejected" | "deferred";
export type JobBrief = { id: string; status: JobStatus; statusVersion: number; version: number };
export type SyncResult = { opId: string; outcome: SyncOutcome; code?: string; replayed?: true; job?: JobBrief; noteId?: string };

/** A change the server refused. Kept until the technician dismisses it; a note's text stays here with a copy button. */
export type AttentionItem = {
  opId: string;
  op: WireOp;
  label: string;
  outcome: "conflict" | "rejected";
  code: string;
  job?: JobBrief;
  at: number;
};

export type SyncStatus = "idle" | "syncing" | "backoff" | "signed_out" | "forbidden" | "wiped";
