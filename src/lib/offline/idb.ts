/** Promise wrappers over IndexedDB. The factory is a parameter so tests can pass `fake-indexeddb`. */

export const DB_PREFIX = "fsd-";
export const DB_VERSION = 1;
export const STORES = ["snapshot", "outbox", "attention", "meta"] as const;
export type StoreName = (typeof STORES)[number];

export const dbNameFor = (userId: string) => `${DB_PREFIX}${encodeURIComponent(userId)}`;

export function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

export function openDb(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("snapshot");
      db.createObjectStore("outbox", { keyPath: "seq", autoIncrement: true });
      db.createObjectStore("attention", { keyPath: "opId" });
      db.createObjectStore("meta");
    };
    req.onsuccess = () => {
      const db = req.result;
      // A wipe deletes the database: let go of it at once instead of blocking the deletion.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
    req.onblocked = () => reject(new Error("IndexedDB open blocked"));
  });
}

export function deleteDb(factory: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = factory.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("IndexedDB delete failed"));
    // `blocked` is only a notice: open connections get `versionchange`, close, and the delete then completes.
  });
}

/** Run `work` in one transaction over `stores`; resolves with its result once the transaction has committed. */
export function withTx<T>(db: IDBDatabase, stores: StoreName[], mode: IDBTransactionMode, work: (tx: IDBTransaction) => Promise<T> | T): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let result: T;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    Promise.resolve(work(tx)).then(
      (r) => {
        result = r;
      },
      (err) => {
        reject(err);
        try {
          tx.abort();
        } catch {
          // already finished
        }
      },
    );
  });
}

/** Every `fsd-*` database this origin has: `databases()` where it exists, plus the names this app registered. */
export async function listAppDatabases(factory: IDBFactory, registry: string[]): Promise<string[]> {
  const names = new Set(registry.filter((n) => n.startsWith(DB_PREFIX)));
  try {
    const listed = factory.databases ? await factory.databases() : [];
    for (const d of listed) if (d.name?.startsWith(DB_PREFIX)) names.add(d.name);
  } catch {
    // older browsers: the registry is all we have
  }
  return [...names];
}
