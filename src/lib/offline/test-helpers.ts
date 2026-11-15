/** Shared fixtures for the offline client tests (not a test file). */
import { IDBFactory } from "fake-indexeddb";
import { TechDataEngine, type EngineEnv } from "./engine";
import { OfflineStore } from "./store";
import type { StoredSnapshot, TechJob } from "./types";

export const newFactory = () => new IDBFactory();

export class MemoryStorage {
  private map = new Map<string, string>();
  getItem = (k: string) => this.map.get(k) ?? null;
  setItem = (k: string, v: string) => void this.map.set(k, v);
  removeItem = (k: string) => void this.map.delete(k);
}

export const job = (over: Partial<TechJob> = {}): TechJob => ({
  id: "11111111-1111-4111-8111-111111111111",
  number: 7,
  title: "Kitchen sink",
  description: "Leaking",
  priority: "normal",
  status: "scheduled",
  version: 3,
  statusVersion: 1,
  scheduledStart: null,
  scheduledEnd: null,
  completedAt: null,
  customer: { name: "Acme", phone: "555-0100" },
  site: { label: "Main", address: "1 Main St", accessNotes: "", lat: null, lng: null },
  notes: [],
  notesTruncated: false,
  ...over,
});

export const snapshotFor = (userId: string, jobs: TechJob[], savedAt = 1_000_000): StoredSnapshot => ({
  userId,
  serverTime: new Date(savedAt).toISOString(),
  jobs,
  truncated: false,
  savedAt,
  etag: 'W/"abc"',
});

export const reply = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export type Rig = {
  factory: IDBFactory;
  storage: MemoryStorage;
  clock: { t: number };
  timers: { fn: () => void; ms: number; id: number; cleared: boolean }[];
  fetch: ReturnType<typeof import("vitest").vi.fn>;
  wiped: { n: number };
  open: (userId: string) => Promise<TechDataEngine>;
  env: EngineEnv;
};

/** An engine rig with a controllable clock, timers and fetch. */
export function rig(vi: typeof import("vitest").vi, fetchImpl: (url: string, init?: RequestInit) => Promise<Response> | Response): Rig {
  const factory = newFactory();
  const storage = new MemoryStorage();
  const clock = { t: 5_000_000 };
  const timers: Rig["timers"] = [];
  const wiped = { n: 0 };
  let ids = 0;
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => fetchImpl(url, init));
  const env: EngineEnv = {
    fetch: fetchFn as unknown as typeof fetch,
    now: () => clock.t,
    random: () => 0.5,
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
    setTimer: (fn, ms) => {
      const t = { fn, ms, id: timers.length, cleared: false };
      timers.push(t);
      return t.id;
    },
    clearTimer: (h) => {
      const t = timers[h as number];
      if (t) t.cleared = true;
    },
    wipe: async () => {
      wiped.n++;
    },
  };
  return {
    factory,
    storage,
    clock,
    timers,
    fetch: fetchFn,
    wiped,
    env,
    open: async (userId) => new TechDataEngine(await OfflineStore.openForUser(userId, { indexedDB: factory, localStorage: storage, now: () => clock.t }), env),
  };
}
