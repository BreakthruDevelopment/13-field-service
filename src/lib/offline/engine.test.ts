import { describe, expect, it } from "vitest";
import {
  applyResults,
  classifyResponse,
  emptyState,
  enqueueNote,
  enqueueStatus,
  nextDelay,
  project,
  selectBatch,
  shouldWipeSnapshot,
} from "@/lib/offline/engine";
import { groupJobs, statusActions, syncLabel, transitionAllowed, type TechJob } from "@/lib/tech-view";

const now = new Date("2026-06-15T15:00:00.000Z");

function job(partial: Partial<TechJob> & Pick<TechJob, "id">): TechJob {
  return {
    number: 1,
    title: "Visit",
    description: "",
    priority: "normal",
    status: "scheduled",
    statusVersion: 1,
    version: 1,
    scheduledStart: null,
    scheduledEnd: null,
    completedAt: null,
    customerName: "Ada",
    customerPhone: "555",
    siteLabel: "Site",
    siteAddress: "1 Main",
    accessNotes: "",
    siteLat: null,
    siteLng: null,
    notes: [],
    checkIn: null,
    ...partial,
  };
}

describe("offline engine", () => {
  it("wipes another person's snapshot and one older than a week", () => {
    const fresh = { ...emptyState(), ownerId: "tech", savedAt: now.toISOString() };
    expect(shouldWipeSnapshot(fresh, "other", now)).toBe(true);
    expect(shouldWipeSnapshot(fresh, "tech", now)).toBe(false);
    expect(shouldWipeSnapshot({ ...fresh, savedAt: null }, "tech", now)).toBe(false);
    expect(shouldWipeSnapshot({ ...fresh, savedAt: "not-a-date" }, "tech", now)).toBe(true);
    const old = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString();
    expect(shouldWipeSnapshot({ ...fresh, savedAt: old }, "tech", now)).toBe(true);
  });

  it("chains status ops on the projected version and keeps a note until the server answers", () => {
    const base = { ...emptyState(), serverJobs: [job({ id: "j1", status: "scheduled", statusVersion: 3 })] };
    const noted = enqueueNote(base, "j1", "  Gate code  ", "n1", now);
    expect(noted.error).toBeNull();
    const first = enqueueStatus(noted.state, "j1", "en_route", "s1", now);
    const second = enqueueStatus(first.state, "j1", "on_site", "s2", now, {
      lat: 1,
      lng: 2,
      accuracyM: 5,
      capturedAt: now.toISOString(),
    });
    expect(first.state.outbox[1]).toMatchObject({ baseStatusVersion: 3, dependsOn: null, to: "en_route" });
    expect(second.state.outbox[2]).toMatchObject({ baseStatusVersion: 4, dependsOn: "s1", to: "on_site" });
    const projected = project(second.state);
    expect(projected[0]?.status).toBe("on_site");
    expect(projected[0]?.statusVersion).toBe(5);
    expect(projected[0]?.notes.map((note) => note.body)).toEqual(["Gate code"]);
    expect(enqueueNote(base, "j1", "   ", "n2", now).error).toBe("Write a note first.");
    expect(enqueueStatus(base, "j1", "completed", "s3", now).error).toBe("That status change isn't available.");
  });

  it("keeps a rejected note, drops the job when it is no longer assigned, and holds deferred ops", () => {
    const state = {
      ...emptyState(),
      serverJobs: [job({ id: "j1", status: "scheduled", statusVersion: 1 })],
      outbox: [
        { seq: 1, opId: "n1", kind: "note.add" as const, jobId: "j1", body: "Keep me", clientAt: now.toISOString() },
        { seq: 2, opId: "s1", kind: "status.set" as const, jobId: "j1", to: "en_route", clientAt: now.toISOString() },
      ],
    };
    const rejected = applyResults(
      state,
      [{ opId: "n1", outcome: "rejected", code: "not_assigned" }],
      now,
    );
    expect(rejected.serverJobs).toHaveLength(0);
    expect(rejected.outbox.map((op) => op.opId)).toEqual(["s1"]);
    expect(rejected.attention[0]).toMatchObject({ noteBody: "Keep me", code: "not_assigned" });

    const deferred = applyResults(state, [{ opId: "s1", outcome: "deferred" }], now);
    expect(deferred.outbox).toHaveLength(2);
    expect(deferred.attention).toHaveLength(0);

    const conflict = applyResults(
      state,
      [{ opId: "s1", outcome: "conflict", code: "stale_version", job: { id: "j1", status: "on_hold", statusVersion: 4, version: 9 } }],
      now,
    );
    expect(conflict.serverJobs[0]).toMatchObject({ status: "on_hold", statusVersion: 4, version: 9 });
    expect(conflict.outbox.map((op) => op.opId)).toEqual(["n1"]);
  });

  it("caps the batch and the backoff", () => {
    const ops = Array.from({ length: 51 }, (_, index) => ({
      seq: index + 1,
      opId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      kind: "note.add" as const,
      jobId: "j1",
      body: "n",
      clientAt: now.toISOString(),
    }));
    expect(selectBatch(ops)).toHaveLength(50);
    const huge = { ...ops[0]!, body: "x".repeat(70_000) };
    expect(selectBatch([huge, { ...huge, seq: 2, opId: ops[1]!.opId }])).toHaveLength(1);
    expect(nextDelay(0, () => 0)).toBe(0);
    expect(nextDelay(0, () => 0.5)).toBe(1000);
    expect(nextDelay(20, () => 0.5)).toBe(150_000);
  });

  it("classifies transport results", () => {
    expect(classifyResponse(200)).toBe("ok");
    expect(classifyResponse(401)).toBe("unauthorized");
    expect(classifyResponse(429)).toBe("retry");
    expect(classifyResponse(500)).toBe("retry");
    expect(classifyResponse(400)).toBe("retry");
  });
});

describe("technician job view", () => {
  it("groups active work into today and keeps a future day upcoming", () => {
    const localNow = new Date(2026, 5, 15, 9, 0, 0);
    const tomorrow = new Date(2026, 5, 16, 9, 0, 0).toISOString();
    const groups = groupJobs(
      [
        job({ id: "active", status: "on_site", scheduledStart: tomorrow }),
        job({ id: "later", status: "scheduled", scheduledStart: tomorrow }),
        job({ id: "done", status: "completed", completedAt: localNow.toISOString() }),
        job({ id: "open", status: "scheduled", scheduledStart: null }),
      ],
      localNow,
    );
    expect(groups.today.map((item) => item.id)).toEqual(["active", "open"]);
    expect(groups.upcoming.map((item) => item.id)).toEqual(["later"]);
    expect(groups.recent.map((item) => item.id)).toEqual(["done"]);
  });

  it("requires a note before completion and offers check-in as the way on site", () => {
    expect(transitionAllowed("scheduled", "on_site", 0)).toEqual({ ok: true, noteRequired: false });
    expect(transitionAllowed("on_site", "completed", 0)).toEqual({ ok: false, noteRequired: true });
    expect(transitionAllowed("on_hold", "on_site", 0)).toEqual({ ok: false, noteRequired: true });
    expect(transitionAllowed("on_site", "en_route", 2).ok).toBe(false);
    const actions = statusActions("scheduled", 0);
    expect(actions.map((action) => action.label)).toEqual(["En route", "Check in at site"]);
    expect(actions.find((action) => action.to === "on_site")?.checkIn).toBe(true);
    expect(statusActions("on_site", 0).find((action) => action.to === "completed")?.reason).toBe("Add a note first.");
  });

  it("names the sync chip", () => {
    expect(syncLabel({ offline: true, syncing: false, pending: 2, attention: 0, needsSignIn: false })).toBe("Offline · 2 waiting");
    expect(syncLabel({ offline: false, syncing: false, pending: 0, attention: 0, needsSignIn: true })).toBe("Sign in again to sync");
    expect(syncLabel({ offline: false, syncing: false, pending: 0, attention: 0, needsSignIn: false })).toBe("Saved");
  });
});
