import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { listAppDatabases, openDb } from "./idb";
import { OfflineStore } from "./store";
import { MemoryStorage, job, newFactory, snapshotFor } from "./test-helpers";
import { PENDING_SIGNOUT_KEY, type SignOutEnv, finishPendingSignOut, isSignOutPending, signOutAndWipe, wipeLocalData } from "./wipe";
import type { NoteOp } from "./types";

const op = (n: number): NoteOp => ({ kind: "note.add", opId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, jobId: "j", clientAt: "2026-11-15T10:00:00.000Z", body: `n${n}` });

class FakeCaches {
  store = new Map<string, Map<string, string>>([
    ["fsd-static-b1", new Map([["/_next/static/a.js", "js"]])],
    ["fsd-shell-b1", new Map([["/tech", "<html>"]])],
    ["something-else", new Map()],
  ]);
  keys = async () => [...this.store.keys()];
  delete = async (k: string) => this.store.delete(k);
}

async function device(online = true) {
  const factory = newFactory();
  const storage = new MemoryStorage();
  const caches = new FakeCaches();
  const store = await OfflineStore.openForUser("tech-1", { indexedDB: factory, localStorage: storage });
  await store.putSnapshot(snapshotFor("tech-1", [job()]));
  await store.enqueue({ op: op(1), label: "x", createdAt: 1 });
  await store.enqueue({ op: op(2), label: "x", createdAt: 2 });
  const posted: unknown[] = [];
  const worker = { postMessage: (m: unknown) => void posted.push(m) };
  const calls: string[] = [];
  const env: SignOutEnv & { online: boolean } = {
    indexedDB: factory,
    localStorage: storage,
    caches,
    serviceWorker: { controller: worker, getRegistrations: async () => [{ active: worker }] },
    haltEngines: () => void store.close(),
    fetch: vi.fn(async (url: string) => {
      calls.push(`fetch ${url}`);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch,
    signOut: vi.fn(async () => {
      calls.push("signOut");
      return {};
    }),
    isOnline: () => env.online,
    online,
  };
  return { env, factory, storage, caches, posted, calls };
}

describe("wipeLocalData", () => {
  it("leaves no fsd-* database, no cache and no registry, and tells the service worker to drop its caches", async () => {
    const d = await device();
    await wipeLocalData(d.env);
    expect(await listAppDatabases(d.factory, [])).toEqual([]);
    expect(await d.caches.keys()).toEqual([]);
    expect(d.storage.getItem("fsd.dbs")).toBeNull();
    expect(d.posted).toEqual([{ type: "wipe" }, { type: "wipe" }]);
  });

  it("works with no caches or service worker and finds databases through the registry alone", async () => {
    const d = await device();
    const bare = { ...d.env, caches: undefined, serviceWorker: undefined };
    await wipeLocalData(bare);
    expect(await listAppDatabases(d.factory, [])).toEqual([]);
  });

  it("reports a wipe that failed half way instead of pretending", async () => {
    const d = await device();
    const broken = { ...d.env, caches: { keys: async () => { throw new Error("denied"); }, delete: async () => false } };
    await expect(wipeLocalData(broken)).rejects.toThrow(/Couldn't clear/);
    expect(await listAppDatabases(d.factory, [])).toEqual([]); // the rest still happened
  });
});

describe("signOutAndWipe", () => {
  it("wipes before it signs out, then asks for Clear-Site-Data; afterwards nothing is left", async () => {
    const d = await device();
    const order: string[] = [];
    const env = { ...d.env, signOut: vi.fn(async () => { order.push(`signOut after ${(await listAppDatabases(d.factory, [])).length} dbs and ${(await d.caches.keys()).length} caches`); return {}; }) };
    const result = await signOutAndWipe(env);
    expect(result).toEqual({ status: "signed_out", unsynced: 2 });
    expect(order).toEqual(["signOut after 0 dbs and 0 caches"]);
    expect(d.calls).toEqual(["fetch /api/session/clear"]);
    expect(d.storage.getItem(PENDING_SIGNOUT_KEY)).toBeNull();
    expect(await listAppDatabases(d.factory, [])).toEqual([]);
    expect(await d.caches.keys()).toEqual([]);
  });

  it("warns about unsynced changes and stays signed in, with everything intact, when the technician says no", async () => {
    const d = await device();
    const confirmLoss = vi.fn(() => false);
    expect(await signOutAndWipe({ ...d.env, confirmLoss })).toEqual({ status: "cancelled", unsynced: 2 });
    expect(confirmLoss).toHaveBeenCalledWith(2);
    expect(d.env.signOut).not.toHaveBeenCalled();
    expect((await listAppDatabases(d.factory, [])).length).toBe(1);
    expect((await d.caches.keys()).length).toBe(3);
    expect(await signOutAndWipe({ ...d.env, confirmLoss: () => true })).toMatchObject({ status: "signed_out" });
  });

  it("doesn't ask when nothing is unsynced", async () => {
    const d = await device();
    const store = await OfflineStore.openForUser("tech-1", { indexedDB: d.factory, localStorage: d.storage });
    const [a, b] = await store.outbox();
    await store.settle([a.op.opId, b.op.opId]);
    store.close();
    const confirmLoss = vi.fn(() => false);
    expect(await signOutAndWipe({ ...d.env, confirmLoss })).toMatchObject({ status: "signed_out", unsynced: 0 });
    expect(confirmLoss).not.toHaveBeenCalled();
  });

  it("signed out offline: the device is wiped at once and the server sign-out waits for the next online open", async () => {
    const d = await device(false);
    expect(await signOutAndWipe(d.env)).toEqual({ status: "wiped_offline", unsynced: 2 });
    expect(await listAppDatabases(d.factory, [])).toEqual([]);
    expect(await d.caches.keys()).toEqual([]);
    expect(d.env.signOut).not.toHaveBeenCalled();
    expect(d.storage.getItem(PENDING_SIGNOUT_KEY)).toBe("1");

    expect(await finishPendingSignOut(d.env)).toBe(false); // still offline
    d.env.online = true;
    expect(await finishPendingSignOut(d.env)).toBe(true);
    expect(d.env.signOut).toHaveBeenCalledTimes(1);
    expect(d.calls).toContain("fetch /api/session/clear");
    expect(d.storage.getItem(PENDING_SIGNOUT_KEY)).toBeNull();
    expect(await finishPendingSignOut(d.env)).toBe(false); // nothing left to finish
  });

  it("finishing a pending sign-out signs out on the server first and wipes again after it, so nothing written meanwhile survives", async () => {
    const d = await device(false);
    await signOutAndWipe(d.env);
    d.env.online = true;
    let flagDuringSignOut: string | null = null;
    const env = {
      ...d.env,
      signOut: vi.fn(async () => {
        flagDuringSignOut = d.storage.getItem(PENDING_SIGNOUT_KEY);
        (await openDb(d.factory, "fsd-late")).close(); // something opened the database while the call was in flight
        d.caches.store.set("late", new Map());
      }),
    };
    expect(await finishPendingSignOut(env)).toBe(true);
    expect(flagDuringSignOut).toBe("1"); // the flag (which keeps the app from opening the database) is held until the end
    expect(await listAppDatabases(d.factory, [])).toEqual([]);
    expect(await d.caches.keys()).toEqual([]);
    expect(d.storage.getItem(PENDING_SIGNOUT_KEY)).toBeNull();
  });

  it("a server sign-out that fails leaves the flag set so the app keeps its hands off the database", async () => {
    const d = await device(false);
    await signOutAndWipe(d.env);
    d.env.online = true;
    expect(await finishPendingSignOut({ ...d.env, signOut: vi.fn(async () => ({ error: "x" })) })).toBe(false);
    expect(isSignOutPending(d.storage)).toBe(true);
  });

  it("a wipe announces itself to the other tabs once", async () => {
    const d = await device();
    const announceWipe = vi.fn();
    await wipeLocalData({ ...d.env, announceWipe });
    expect(announceWipe).toHaveBeenCalledTimes(1);
    await wipeLocalData({ ...d.env, announceWipe: () => { throw new Error("no channel"); } }); // never fails the wipe
  });

  it("a failed server sign-out keeps the pending flag (and the wipe stays done)", async () => {
    const d = await device();
    const env = { ...d.env, signOut: vi.fn(async () => ({ error: { message: "nope" } })) };
    expect(await signOutAndWipe(env)).toMatchObject({ status: "wiped_offline" });
    expect(d.storage.getItem(PENDING_SIGNOUT_KEY)).toBe("1");
    expect(await listAppDatabases(d.factory, [])).toEqual([]);
  });

  it("a signOut that throws is a failed sign-out, not a crash", async () => {
    const d = await device();
    const env = { ...d.env, signOut: vi.fn(async () => { throw new Error("network"); }) };
    expect(await signOutAndWipe(env)).toMatchObject({ status: "wiped_offline" });
  });
});
