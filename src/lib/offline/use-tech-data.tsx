"use client";

import { type ReactNode, createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createBrowserEngine, leaveForSignIn, onWipedElsewhere } from "./browser";
import type { EngineState, TechDataEngine } from "./engine";
import { attachTriggers } from "./triggers";
import { isSignOutPending } from "./wipe";
import type { CheckInLocation, JobStatus } from "./types";

/**
 * The technician pages' data, offline first. `<TechDataProvider userId>` (mounted once by `src/app/tech/layout.tsx`, which
 * knows the signed-in user) opens that user's IndexedDB, shows the saved snapshot at once with no network, then refreshes
 * it and flushes the outbox. `useTechData()` is what the pages call. See `engine.ts` for the contracts.
 */
const Ctx = createContext<TechDataEngine | null>(null);

const emptyState = (userId: string): EngineState => ({
  ready: false,
  userId,
  jobs: [],
  hasSnapshot: false,
  truncated: false,
  snapshotSavedAt: null,
  pending: 0,
  attention: [],
  status: "idle",
  lastSyncedAt: null,
  nextRetryAt: null,
});

export function TechDataProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const [engine, setEngine] = useState<TechDataEngine | null>(null);
  useEffect(() => {
    let cancelled = false;
    let detach: (() => void) | undefined;
    let created: TechDataEngine | undefined;
    // Signed out in another tab: this one stops, drops what it shows and leaves for sign-in.
    const stopListening = onWipedElsewhere(() => {
      cancelled = true;
      detach?.();
      created?.halt();
      setEngine(null);
      leaveForSignIn();
    });
    void (async () => {
      try {
        // A sign-out is unfinished on this device: don't open the database, download a snapshot or flush anything.
        if (isSignOutPending(window.localStorage)) return;
        const e = await createBrowserEngine(userId);
        if (cancelled) return void e.halt();
        created = e;
        await e.load();
        setEngine(e);
        detach = attachTriggers(e, { window, document, setInterval: (fn, ms) => window.setInterval(fn, ms), clearInterval: (h) => window.clearInterval(h as number) });
        void e.refresh();
        void e.flush();
      } catch {
        // IndexedDB unavailable (private mode on some browsers): the pages still work online through the plain API.
      }
    })();
    return () => {
      cancelled = true;
      stopListening();
      detach?.();
      created?.halt();
      setEngine(null);
    };
  }, [userId]);
  return <Ctx.Provider value={engine}>{children}</Ctx.Provider>;
}

export type TechData = EngineState & {
  addNote: (jobId: string, body: string, opId?: string) => Promise<string>;
  setStatus: (jobId: string, to: JobStatus, opts?: { location?: CheckInLocation | null; opId?: string }) => Promise<string>;
  refresh: () => Promise<void>;
  flush: () => Promise<void>;
  dismissAttention: (opId: string) => Promise<void>;
};

const noopSubscribe = () => () => undefined;

export function useTechData(): TechData {
  const engine = useContext(Ctx);
  const userId = engine?.userId ?? "";
  const fallback = useMemo(() => emptyState(userId), [userId]);
  const state = useSyncExternalStore(engine ? engine.subscribe : noopSubscribe, engine ? engine.getState : () => fallback, () => fallback);
  return useMemo(
    () => ({
      ...state,
      addNote: (jobId, body, opId) => (engine ? engine.addNote(jobId, body, opId) : Promise.reject(new Error("Offline storage isn't ready"))),
      setStatus: (jobId, to, opts) => (engine ? engine.setStatus(jobId, to, opts) : Promise.reject(new Error("Offline storage isn't ready"))),
      refresh: () => engine?.refresh() ?? Promise.resolve(),
      flush: () => engine?.flush({ force: true }) ?? Promise.resolve(),
      dismissAttention: (opId) => engine?.dismissAttention(opId) ?? Promise.resolve(),
    }),
    [engine, state],
  );
}
