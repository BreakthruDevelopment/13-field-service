"use client";

import { signOut } from "@/lib/auth/client";
import { TechDataEngine, type EngineEnv } from "./engine";
import { dbNameFor, deleteDb } from "./idb";
import { OfflineStore } from "./store";
import { type SignOutEnv, type SignOutResult, type WipeEnv, finishPendingSignOut as finish, signOutAndWipe as signOutAndWipeWith } from "./wipe";

/** The real browser bindings for the framework-free offline core. Only client code imports this file. */

const engines = new Set<TechDataEngine>();

export const haltAllEngines = () => {
  for (const e of engines) e.halt();
  engines.clear();
};

const WIPE_CHANNEL = "fsd-wipe";
const TAB_ID = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Math.random());

function announceWipe() {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(WIPE_CHANNEL);
  channel.postMessage({ from: TAB_ID });
  channel.close();
}

/** Call `onWipe` when ANOTHER tab of this browser wipes the device (sign-out). Returns the unsubscribe. */
export function onWipedElsewhere(onWipe: () => void): () => void {
  if (typeof BroadcastChannel === "undefined") return () => undefined;
  const channel = new BroadcastChannel(WIPE_CHANNEL);
  channel.onmessage = (e: MessageEvent) => {
    if (e.data?.from !== TAB_ID) onWipe();
  };
  return () => channel.close();
}

function wipeEnv(): WipeEnv {
  return {
    indexedDB: window.indexedDB,
    caches: "caches" in window ? window.caches : undefined,
    localStorage: window.localStorage,
    serviceWorker: "serviceWorker" in navigator ? navigator.serviceWorker : undefined,
    haltEngines: haltAllEngines,
    announceWipe,
  };
}

function signOutEnv(confirmLoss?: SignOutEnv["confirmLoss"]): SignOutEnv {
  return { ...wipeEnv(), fetch: window.fetch.bind(window), signOut, isOnline: () => navigator.onLine, confirmLoss };
}

/** Open (or create) this user's offline database and the engine on it. Any other user's data on this device is deleted first. */
export async function createBrowserEngine(userId: string): Promise<TechDataEngine> {
  const store = await OfflineStore.openForUser(userId, { indexedDB: window.indexedDB, localStorage: window.localStorage });
  const locks = navigator.locks;
  const env: EngineEnv = {
    fetch: window.fetch.bind(window),
    now: Date.now,
    random: Math.random,
    newId: () => crypto.randomUUID(),
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (h) => window.clearTimeout(h as number),
    withLock: locks
      ? async <T,>(name: string, fn: () => Promise<T>) => {
          const out = await locks.request(name, { ifAvailable: true }, async (lock) => (lock ? { ran: true as const, value: await fn() } : { ran: false as const }));
          return out.ran ? out.value : undefined;
        }
      : undefined,
    exclusive: locks
      ? async <T,>(name: string, fn: () => Promise<T>) => (await locks.request(name, async () => ({ value: await fn() }))).value
      : undefined,
    broadcast:
      typeof BroadcastChannel === "undefined"
        ? undefined
        : (() => {
            const channel = new BroadcastChannel(`fsd-${userId}`);
            const listeners = new Set<() => void>();
            channel.onmessage = () => listeners.forEach((l) => l());
            return {
              post: () => channel.postMessage("changed"),
              subscribe: (cb: () => void) => {
                listeners.add(cb);
                return () => {
                  listeners.delete(cb);
                };
              },
            };
          })(),
    discardOwn: async (id) => {
      // Not the registry: it may now name another user's database, which is not ours to touch or forget.
      await deleteDb(window.indexedDB, dbNameFor(id));
    },
    onHalt: (e) => void engines.delete(e),
  };
  const engine = new TechDataEngine(store, env);
  engines.add(engine);
  return engine;
}

/** The Sign out button: warns about unsynced changes, wipes this device, signs out, asks the browser to clear site data. */
export function signOutAndWipe(): Promise<SignOutResult> {
  return signOutAndWipeWith(
    signOutEnv((n) => window.confirm(`${n} change${n === 1 ? "" : "s"} not synced will be lost. Sign out anyway?`)),
  );
}

/** Run on every page load: finishes a sign-out that was left half done offline. */
export function finishPendingSignOut(): Promise<boolean> {
  return finish(signOutEnv());
}

/** A full page load of the sign-in page (not a client navigation): it drops everything this tab still holds in memory. */
export function leaveForSignIn(): void {
  window.location.replace(new URL("/sign-in", window.location.href));
}
