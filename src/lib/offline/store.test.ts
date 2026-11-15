import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { dbNameFor, listAppDatabases } from "./idb";
import { OfflineStore, REGISTRY_KEY, SNAPSHOT_MAX_AGE_MS, countUnsynced } from "./store";
import { MemoryStorage, job, newFactory, snapshotFor } from "./test-helpers";
import type { NoteOp } from "./types";

const noteOp = (n: number): NoteOp => ({ kind: "note.add", opId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, jobId: "j", clientAt: "2026-11-15T10:00:00.000Z", body: `note ${n}` });
const open = (factory: IDBFactory, userId: string, storage = new MemoryStorage(), now = () => 1_000_000) => OfflineStore.openForUser(userId, { indexedDB: factory, localStorage: storage, now });

describe("OfflineStore", () => {
  it("the outbox survives a reload, in order", async () => {
    const factory = newFactory();
    const a = await open(factory, "u1");
    await a.enqueue({ op: noteOp(1), label: "#1", createdAt: 1 });
    await a.enqueue({ op: noteOp(2), label: "#1", createdAt: 2 });
    a.close();
    const b = await open(factory, "u1");
    expect((await b.outbox()).map((q) => q.op.opId.slice(-1))).toEqual(["1", "2"]);
  });

  it("the same op id queued twice is one op (a double tap or a retry)", async () => {
    const store = await open(newFactory(), "u1");
    const first = await store.enqueue({ op: noteOp(1), label: "a", createdAt: 1 });
    const second = await store.enqueue({ op: noteOp(1), label: "b", createdAt: 2 });
    expect(second).toBe(first);
    expect(await store.outbox()).toHaveLength(1);
  });

  it("settle removes only the answered ops and records the refused ones", async () => {
    const store = await open(newFactory(), "u1");
    for (const n of [1, 2, 3]) await store.enqueue({ op: noteOp(n), label: "x", createdAt: n });
    const [one, two] = await store.outbox();
    await store.settle([one.op.opId, two.op.opId], [{ opId: two.op.opId, op: two.op, label: "x", outcome: "rejected", code: "not_assigned", at: 9 }]);
    expect((await store.outbox()).map((q) => q.op.opId.slice(-1))).toEqual(["3"]);
    expect(await store.attention()).toMatchObject([{ opId: two.op.opId, code: "not_assigned" }]);
    await store.dismissAttention(two.op.opId);
    expect(await store.attention()).toEqual([]);
  });

  it("opening for a different user deletes the previous user's database, outbox included", async () => {
    const factory = newFactory();
    const storage = new MemoryStorage();
    const a = await open(factory, "userA", storage);
    await a.putSnapshot(snapshotFor("userA", [job()]));
    await a.enqueue({ op: noteOp(1), label: "x", createdAt: 1 });
    a.close();
    expect(await listAppDatabases(factory, [])).toEqual([dbNameFor("userA")]);
    const b = await open(factory, "userB", storage);
    expect(await listAppDatabases(factory, [])).toEqual([dbNameFor("userB")]);
    expect(await b.getSnapshot()).toBeNull();
    expect(await b.outbox()).toEqual([]);
    expect(JSON.parse(storage.getItem(REGISTRY_KEY)!)).toEqual([dbNameFor("userB")]);
  });

  it("a different user is wiped even while the previous user's connection is still open", async () => {
    const factory = newFactory();
    const storage = new MemoryStorage();
    await open(factory, "userA", storage); // left open
    await open(factory, "userB", storage);
    expect(await listAppDatabases(factory, [])).toEqual([dbNameFor("userB")]);
  });

  it("finds databases through the registry when the browser has no indexedDB.databases()", async () => {
    const factory = newFactory();
    const storage = new MemoryStorage();
    const a = await open(factory, "userA", storage);
    a.close();
    const legacy = Object.create(factory, { databases: { value: undefined } }) as IDBFactory;
    expect(await listAppDatabases(legacy, JSON.parse(storage.getItem(REGISTRY_KEY)!))).toEqual([dbNameFor("userA")]);
  });

  it("deletes a snapshot older than 7 days before anything can render it, and keeps unsent work", async () => {
    const factory = newFactory();
    let now = 1_000_000;
    const a = await open(factory, "u1", new MemoryStorage(), () => now);
    await a.putSnapshot(snapshotFor("u1", [job()], now));
    await a.enqueue({ op: noteOp(1), label: "x", createdAt: 1 });
    a.close();
    now += SNAPSHOT_MAX_AGE_MS - 1000;
    const fresh = await open(factory, "u1", new MemoryStorage(), () => now);
    expect(await fresh.getSnapshot()).not.toBeNull();
    fresh.close();
    now += 2000;
    const stale = await open(factory, "u1", new MemoryStorage(), () => now);
    expect(await stale.getSnapshot()).toBeNull();
    expect(await stale.outbox()).toHaveLength(1);
  });

  it("deletes a snapshot that names another user", async () => {
    const factory = newFactory();
    const store = await open(factory, "u1");
    await store.putSnapshot(snapshotFor("someone-else", [job()]));
    store.close();
    const again = await open(factory, "u1");
    expect(await again.getSnapshot()).toBeNull();
  });

  it("refuses to be used after close", async () => {
    const store = await open(newFactory(), "u1");
    store.close();
    await expect(store.outbox()).rejects.toThrow(/closed/);
  });

  it("countUnsynced counts every database's outbox and never creates one", async () => {
    const factory = newFactory();
    const storage = new MemoryStorage();
    const a = await open(factory, "u1", storage);
    await a.enqueue({ op: noteOp(1), label: "x", createdAt: 1 });
    await a.enqueue({ op: noteOp(2), label: "x", createdAt: 2 });
    expect(await countUnsynced({ indexedDB: factory, localStorage: storage })).toBe(2);
    storage.setItem(REGISTRY_KEY, JSON.stringify([dbNameFor("u1"), "fsd-ghost"]));
    expect(await countUnsynced({ indexedDB: factory, localStorage: storage })).toBe(2);
    expect(await listAppDatabases(factory, [])).toEqual([dbNameFor("u1")]);
  });
});
