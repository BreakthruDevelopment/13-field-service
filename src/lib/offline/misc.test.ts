import { describe, expect, it, vi } from "vitest";
import { BACKOFF_MAX_MS, BACKOFF_MIN_MS, backoffMs, retryAfterMs } from "./backoff";
import { captureCheckInLocation } from "./geolocation";
import { WORK_TRANSITIONS, cleanNote, overlay } from "./rules";
import { job, rig, snapshotFor } from "./test-helpers";
import { attachTriggers } from "./triggers";
import { JOB_STATUSES, WORK_TRANSITIONS as SERVER_TRANSITIONS, transitionNeedsNote } from "@/lib/job-status";
import { transitionNeedsNote as clientNeedsNote } from "./rules";

describe("backoff", () => {
  it("grows 2 s, 4 s, 8 s ... to 5 min with full jitter, never under 1 s", () => {
    expect(backoffMs(0, () => 1)).toBe(2000);
    expect(backoffMs(1, () => 1)).toBe(4000);
    expect(backoffMs(3, () => 1)).toBe(16_000);
    expect(backoffMs(20, () => 1)).toBe(BACKOFF_MAX_MS);
    expect(backoffMs(5, () => 0)).toBe(BACKOFF_MIN_MS);
    expect(backoffMs(2, () => 0.5)).toBe(4000);
  });
  it("reads Retry-After in seconds and ignores anything else", () => {
    expect(retryAfterMs("120")).toBe(120_000);
    expect(retryAfterMs("99999")).toBe(BACKOFF_MAX_MS);
    expect(retryAfterMs("Wed, 21 Oct 2026 07:28:00 GMT")).toBeNull();
    expect(retryAfterMs(null)).toBeNull();
  });
});

describe("rules", () => {
  it("the phone's status table is the server's", () => {
    expect(WORK_TRANSITIONS).toEqual(SERVER_TRANSITIONS);
    for (const s of JOB_STATUSES) expect(clientNeedsNote(s)).toBe(transitionNeedsNote(s));
  });
  it("cleanNote trims, drops NUL and enforces 1 to 2000 characters", () => {
    expect(cleanNote("  a\0b ")).toBe("ab");
    expect(() => cleanNote("")).toThrow();
    expect(() => cleanNote("x".repeat(2001))).toThrow();
    expect(cleanNote("x".repeat(2000))).toHaveLength(2000);
  });
  it("overlay leaves the snapshot alone and applies queued ops in order", () => {
    const base = [job()];
    const queue = [
      { op: { kind: "status.set" as const, opId: "a", jobId: base[0].id, clientAt: "c1", to: "en_route" as const, baseStatusVersion: 1, dependsOn: null }, label: "", createdAt: 0 },
      { op: { kind: "note.add" as const, opId: "b", jobId: base[0].id, clientAt: "c2", body: "hi" }, label: "", createdAt: 0 },
      { op: { kind: "note.add" as const, opId: "c", jobId: "other", clientAt: "c3", body: "lost" }, label: "", createdAt: 0 },
    ];
    const out = overlay(base, queue);
    expect(out[0]).toMatchObject({ status: "en_route", statusVersion: 2, pendingOps: 2 });
    expect(out[0].notes).toHaveLength(1);
    expect(base[0]).toMatchObject({ status: "scheduled", statusVersion: 1 });
    expect(base[0].notes).toHaveLength(0);
  });
});

describe("captureCheckInLocation", () => {
  const geo = (impl: (ok: PositionCallback, err: PositionErrorCallback, opts?: PositionOptions) => void) => ({ getCurrentPosition: vi.fn(impl) });
  it("asks once, with high accuracy, a 15 s timeout and a 60 s cache, and returns the fix", async () => {
    const g = geo((ok) => ok({ coords: { latitude: 30.26721, longitude: -97.74311, accuracy: 24.4 }, timestamp: Date.parse("2026-11-15T10:00:00Z") } as GeolocationPosition));
    expect(await captureCheckInLocation(g as unknown as Geolocation)).toEqual({ lat: 30.26721, lng: -97.74311, accuracyM: 24.4, capturedAt: "2026-11-15T10:00:00.000Z" });
    expect(g.getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(g.getCurrentPosition.mock.calls[0][2]).toEqual({ enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 });
  });
  it("gives null when denied, timed out, unsupported, throwing or nonsense", async () => {
    expect(await captureCheckInLocation(geo((_ok, err) => err({ code: 1 } as GeolocationPositionError)) as unknown as Geolocation)).toBeNull();
    expect(await captureCheckInLocation(undefined)).toBeNull();
    expect(await captureCheckInLocation({ getCurrentPosition: () => { throw new Error("blocked by policy"); } } as unknown as Geolocation)).toBeNull();
    expect(await captureCheckInLocation(geo((ok) => ok({ coords: { latitude: 99, longitude: 0, accuracy: 1 }, timestamp: 0 } as GeolocationPosition)) as unknown as Geolocation)).toBeNull();
  });
  it("clamps accuracy into the range the server accepts", async () => {
    const fix = await captureCheckInLocation(geo((ok) => ok({ coords: { latitude: 1, longitude: 1, accuracy: 50_000 }, timestamp: 0 } as GeolocationPosition)) as unknown as Geolocation);
    expect(fix?.accuracyM).toBe(10_000);
  });
});

describe("triggers", () => {
  it("flush and refresh on online and on becoming visible; a 60 s tick flushes only when visible with work waiting", async () => {
    const r = rig(vi, () => new Response(JSON.stringify({ userId: "u", serverTime: "t", jobs: [], truncated: false }), { status: 200 }));
    const engine = await r.open("u");
    await engine.load();
    const flush = vi.spyOn(engine, "flush");
    const refresh = vi.spyOn(engine, "refresh");
    const restored = vi.spyOn(engine, "connectivityRestored");
    const listeners: Record<string, () => void> = {};
    const doc = { visibilityState: "hidden", addEventListener: (n: string, f: () => void) => void (listeners[n] = f), removeEventListener: (n: string) => void delete listeners[n] };
    const win = { addEventListener: (n: string, f: () => void) => void (listeners[n] = f), removeEventListener: (n: string) => void delete listeners[n] };
    let tick: () => void = () => undefined;
    const detach = attachTriggers(engine, { window: win as never, document: doc as never, setInterval: (fn) => ((tick = fn), 1), clearInterval: () => undefined });
    listeners.online();
    expect(restored).toHaveBeenCalledTimes(1); // which flushes and refreshes
    const afterOnline = flush.mock.calls.length;
    listeners.visibilitychange(); // still hidden
    expect(flush).toHaveBeenCalledTimes(afterOnline);
    doc.visibilityState = "visible";
    listeners.visibilitychange();
    expect(flush).toHaveBeenCalledTimes(afterOnline + 1);
    expect(refresh).toHaveBeenCalled();
    tick(); // nothing pending
    expect(flush).toHaveBeenCalledTimes(afterOnline + 1);
    detach();
    expect(Object.keys(listeners)).toEqual([]);
    void snapshotFor;
  });
});

describe("applyAcknowledged", () => {
  const note = { kind: "note.add" as const, opId: "n1", jobId: job().id, clientAt: "2026-11-15T10:00:00.000Z", body: "hi" };
  it("takes the server's state only when it isn't older than what is saved, and adds an acknowledged note once", async () => {
    const { applyAcknowledged } = await import("./rules");
    const base = [job({ statusVersion: 3, version: 5 })];
    const fresh = applyAcknowledged(base, [{ op: note, result: { opId: "n1", outcome: "applied", noteId: "s1", job: { id: job().id, status: "on_site", statusVersion: 4, version: 6 } } }], "2026-11-15T10:01:00.000Z");
    expect(fresh[0]).toMatchObject({ status: "on_site", statusVersion: 4, version: 6 });
    expect(fresh[0].notes).toHaveLength(1);
    const twice = applyAcknowledged(fresh, [{ op: note, result: { opId: "n1", outcome: "replayed", noteId: "s1" } }], "x");
    expect(twice[0].notes).toHaveLength(1);
    const stale = applyAcknowledged(base, [{ op: note, result: { opId: "n1", outcome: "replayed", noteId: "s1", job: { id: job().id, status: "scheduled", statusVersion: 1, version: 2 } } }], "x");
    expect(stale[0]).toMatchObject({ statusVersion: 3, version: 5, status: "scheduled" });
    expect(base[0].notes).toHaveLength(0); // pure
    const refused = applyAcknowledged(base, [{ op: note, result: { opId: "n1", outcome: "rejected", code: "job_cancelled" } }], "x");
    expect(refused[0].notes).toHaveLength(0);
  });
});
