import { DB_PREFIX, dbNameFor, deleteDb, listAppDatabases, openDb, promisify, withTx } from "./idb";
import type { AttentionItem, QueuedOp, StoredSnapshot } from "./types";

/** The server session lasts 7 days; a snapshot older than that is deleted before anything renders. */
export const SNAPSHOT_MAX_AGE_MS = 7 * 24 * 3600_000;
export const REGISTRY_KEY = "fsd.dbs";

export type KeyValueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const readRegistry = (storage: KeyValueStorage | undefined): string[] => {
  try {
    const parsed = JSON.parse(storage?.getItem(REGISTRY_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === "string") : [];
  } catch {
    return [];
  }
};

/**
 * One user's offline database, `fsd-<userId>`, with four stores: `snapshot` (the last `/api/my/jobs`), `outbox` (queued
 * ops in local order), `attention` (changes the server refused) and `meta` (the owner). It is bound to its user twice:
 * by name, and by `meta.owner`, which `openForUser` re-checks. Opening for a user first deletes every other `fsd-*`
 * database, so a phone that changes hands never keeps the previous technician's data.
 */
export class OfflineStore {
  private closed = false;

  private constructor(
    private readonly db: IDBDatabase,
    readonly userId: string,
  ) {}

  static async openForUser(userId: string, env: { indexedDB: IDBFactory; localStorage?: KeyValueStorage; now?: () => number }): Promise<OfflineStore> {
    const now = env.now ?? Date.now;
    const mine = dbNameFor(userId);
    for (const name of await listAppDatabases(env.indexedDB, readRegistry(env.localStorage))) {
      if (name !== mine) await deleteDb(env.indexedDB, name);
    }
    const db = await openDb(env.indexedDB, mine);
    const store = new OfflineStore(db, userId);
    const owner = await withTx(db, ["meta"], "readonly", (tx) => promisify(tx.objectStore("meta").get("owner")));
    if (owner !== undefined && owner !== userId) {
      // Can't happen by name; if it ever does, nothing in here is this user's.
      await store.clearAll();
    }
    await withTx(db, ["meta"], "readwrite", (tx) => promisify(tx.objectStore("meta").put(userId, "owner")));
    try {
      // Every other database was just deleted, so the registry is exactly this one.
      env.localStorage?.setItem(REGISTRY_KEY, JSON.stringify([mine]));
    } catch {
      // storage unavailable: databases() covers it
    }
    const snap = await store.getSnapshot();
    if (snap && (snap.userId !== userId || now() - snap.savedAt > SNAPSHOT_MAX_AGE_MS)) await store.clearSnapshot();
    return store;
  }

  private guard() {
    if (this.closed) throw new Error("The offline store was closed");
  }

  close() {
    this.closed = true;
    this.db.close();
  }

  get isClosed() {
    return this.closed;
  }

  async getSnapshot(): Promise<StoredSnapshot | null> {
    this.guard();
    return (await withTx(this.db, ["snapshot"], "readonly", (tx) => promisify(tx.objectStore("snapshot").get("current")))) ?? null;
  }

  async putSnapshot(snapshot: StoredSnapshot): Promise<void> {
    this.guard();
    await withTx(this.db, ["snapshot"], "readwrite", (tx) => promisify(tx.objectStore("snapshot").put(snapshot, "current")));
  }

  async clearSnapshot(): Promise<void> {
    this.guard();
    await withTx(this.db, ["snapshot"], "readwrite", (tx) => promisify(tx.objectStore("snapshot").clear()));
  }

  /** Queue an op. Resolves once it is durably stored; the op's `seq` is its place in line. */
  async enqueue(item: Omit<QueuedOp, "seq">): Promise<number> {
    this.guard();
    return withTx(this.db, ["outbox"], "readwrite", async (tx) => {
      const store = tx.objectStore("outbox");
      // The same op id twice is the same intent (a double tap, a retry): keep the first.
      const all = (await promisify(store.getAll())) as QueuedOp[];
      const same = all.find((q) => q.op.opId === item.op.opId);
      if (same) return same.seq!;
      return (await promisify(store.add(item))) as number;
    });
  }

  async outbox(): Promise<QueuedOp[]> {
    this.guard();
    const all = (await withTx(this.db, ["outbox"], "readonly", (tx) => promisify(tx.objectStore("outbox").getAll()))) as QueuedOp[];
    return all.sort((a, b) => a.seq! - b.seq!);
  }

  /** Remove ops the server gave a final answer to; optionally record refused ones, in the same transaction. */
  async settle(opIds: string[], attention: AttentionItem[] = [], snapshot?: StoredSnapshot): Promise<void> {
    this.guard();
    if (opIds.length === 0 && attention.length === 0) return;
    // One transaction: the answered ops leave the outbox in the same commit that saves what they did to the snapshot,
    // so a crash or a failed refresh can never show the old state with nothing queued.
    await withTx(this.db, ["outbox", "attention", "snapshot"], "readwrite", async (tx) => {
      if (snapshot) await promisify(tx.objectStore("snapshot").put(snapshot, "current"));
      const outbox = tx.objectStore("outbox");
      const all = (await promisify(outbox.getAll())) as QueuedOp[];
      for (const q of all) if (opIds.includes(q.op.opId)) await promisify(outbox.delete(q.seq!));
      const att = tx.objectStore("attention");
      for (const a of attention) await promisify(att.put(a));
    });
  }

  async attention(): Promise<AttentionItem[]> {
    this.guard();
    const all = (await withTx(this.db, ["attention"], "readonly", (tx) => promisify(tx.objectStore("attention").getAll()))) as AttentionItem[];
    return all.sort((a, b) => a.at - b.at);
  }

  async dismissAttention(opId: string): Promise<void> {
    this.guard();
    await withTx(this.db, ["attention"], "readwrite", (tx) => promisify(tx.objectStore("attention").delete(opId)));
  }

  private async clearAll(): Promise<void> {
    await withTx(this.db, ["snapshot", "outbox", "attention", "meta"], "readwrite", async (tx) => {
      for (const name of ["snapshot", "outbox", "attention", "meta"] as const) await promisify(tx.objectStore(name).clear());
    });
  }
}

/** How many unsynced changes sit in the `fsd-*` databases (what "N changes not synced will be lost" counts). Never creates a database. */
export async function countUnsynced(env: { indexedDB: IDBFactory; localStorage?: KeyValueStorage }): Promise<number> {
  let total = 0;
  for (const name of await listAppDatabases(env.indexedDB, readRegistry(env.localStorage))) {
    const db = await new Promise<IDBDatabase | null>((resolve) => {
      const req = env.indexedDB.open(name);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
      req.onupgradeneeded = () => {
        // The database didn't exist (or isn't ours): abandon the open instead of creating it.
        req.transaction?.abort();
      };
    });
    if (!db) continue;
    try {
      if (db.objectStoreNames.contains("outbox")) total += await withTx(db, ["outbox"], "readonly", (tx) => promisify(tx.objectStore("outbox").count()));
    } finally {
      db.close();
    }
  }
  return total;
}

export { DB_PREFIX };
