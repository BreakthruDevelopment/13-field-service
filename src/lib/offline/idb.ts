import { emptyState, type LocalState } from "@/lib/offline/engine";
import type { AttentionItem, OutboxOp, TechJob } from "@/lib/tech-view";

const PREFIX = "fsd-";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function openDb(userId: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(`${PREFIX}${userId}`, 1);
    req.onupgradeneeded = () => {
      const database = req.result;
      if (!database.objectStoreNames.contains("snapshot")) database.createObjectStore("snapshot");
      if (!database.objectStoreNames.contains("outbox")) database.createObjectStore("outbox", { keyPath: "seq" });
      if (!database.objectStoreNames.contains("attention")) database.createObjectStore("attention", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

type SnapshotRecord = { jobs: TechJob[]; savedAt: string | null; ownerId: string | null };

export async function loadLocal(userId: string): Promise<LocalState> {
  if (typeof indexedDB === "undefined") return emptyState();
  try {
    const database = await openDb(userId);
    const snapshot = (await request(database.transaction("snapshot").objectStore("snapshot").get("current"))) as SnapshotRecord | undefined;
    const outbox = (await request(database.transaction("outbox").objectStore("outbox").getAll())) as OutboxOp[];
    const attention = (await request(database.transaction("attention").objectStore("attention").getAll())) as AttentionItem[];
    database.close();
    return {
      serverJobs: snapshot?.jobs ?? [],
      outbox: Array.isArray(outbox) ? outbox : [],
      attention: Array.isArray(attention) ? attention : [],
      savedAt: snapshot?.savedAt ?? null,
      ownerId: snapshot?.ownerId ?? null,
    };
  } catch {
    return emptyState();
  }
}

export async function saveLocal(userId: string, state: LocalState): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const database = await openDb(userId);
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(["snapshot", "outbox", "attention"], "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore("snapshot").put({ jobs: state.serverJobs, savedAt: state.savedAt, ownerId: state.ownerId }, "current");
    const outbox = tx.objectStore("outbox");
    outbox.clear();
    for (const op of state.outbox) outbox.put(op);
    const attention = tx.objectStore("attention");
    attention.clear();
    for (const item of state.attention) attention.put(item);
  });
  database.close();
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

async function fieldDatabases(): Promise<string[]> {
  if (typeof indexedDB === "undefined" || !indexedDB.databases) return [];
  const listed = await indexedDB.databases();
  return listed.map((entry) => entry.name).filter((name): name is string => Boolean(name && name.startsWith(PREFIX)));
}

export async function countPendingOps(): Promise<number> {
  const names = await fieldDatabases();
  let pending = 0;
  for (const name of names) {
    try {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(name);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      if (database.objectStoreNames.contains("outbox")) {
        const ops = await request(database.transaction("outbox").objectStore("outbox").getAll());
        pending += Array.isArray(ops) ? ops.length : 0;
      }
      database.close();
    } catch {
      // A database we can't open is still wiped by the caller.
    }
  }
  return pending;
}

export async function wipeFieldData(userId?: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const names = userId ? [`${PREFIX}${userId}`] : await fieldDatabases();
  await Promise.all(names.map((name) => deleteDatabase(name)));
  if (typeof caches !== "undefined") {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith("fsd-")).map((key) => caches.delete(key)));
  }
  try {
    const registration = await navigator.serviceWorker?.getRegistration("/");
    registration?.active?.postMessage({ type: "CLEAR" });
    navigator.serviceWorker?.controller?.postMessage({ type: "CLEAR" });
  } catch {
    // Signing out still continues when the service worker is gone.
  }
}
