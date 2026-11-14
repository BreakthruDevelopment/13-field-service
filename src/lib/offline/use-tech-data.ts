"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { countPendingOps, loadLocal, saveLocal, wipeFieldData } from "@/lib/offline/idb";
import {
  applyResults,
  classifyResponse,
  dismissAttention,
  emptyState,
  enqueueNote,
  enqueueStatus,
  nextDelay,
  project,
  replaceSnapshot,
  selectBatch,
  shouldWipeSnapshot,
  toSyncPayload,
  type LocalState,
} from "@/lib/offline/engine";
import {
  groupJobs,
  syncLabel,
  type OutboxOp,
  type SyncResult,
  type TechJob,
  type WorkOrderView,
} from "@/lib/tech-view";

const SNAPSHOT_GAP_MS = 5 * 60 * 1000;

function deviceId(): string | null {
  try {
    const key = "fsd-device";
    const existing = localStorage.getItem(key);
    if (existing && /^[0-9a-f-]{36}$/i.test(existing)) return existing;
    const created = crypto.randomUUID();
    localStorage.setItem(key, created);
    return created;
  } catch {
    return null;
  }
}

/** Only the Check in at site handler calls this. Denied or timed out means check in with no location. */
function captureCheckIn(): Promise<OutboxOp["location"]> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude, accuracy } = position.coords;
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(accuracy) || accuracy > 10_000) {
          resolve(null);
          return;
        }
        resolve({ lat: latitude, lng: longitude, accuracyM: accuracy, capturedAt: new Date().toISOString() });
      },
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    );
  });
}

export function useTechData(userId: string) {
  const [state, setState] = useState<LocalState>(emptyState);
  const [ready, setReady] = useState(false);
  const [offline, setOffline] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workOrder, setWorkOrder] = useState<WorkOrderView | null>(null);
  const [workOrderError, setWorkOrderError] = useState<string | null>(null);
  const [workOrderPending, setWorkOrderPending] = useState(false);
  const stateRef = useRef(state);
  const etagRef = useRef<string | null>(null);
  const attemptRef = useRef(0);
  const flushTimer = useRef<number | null>(null);
  const flushing = useRef<Promise<void> | null>(null);
  const flushLockedRef = useRef<(refresh?: boolean) => Promise<void>>(async () => undefined);
  const saveChain = useRef(Promise.resolve());
  const lastSnapshot = useRef(0);

  const persist = useCallback((next: LocalState) => {
    saveChain.current = saveChain.current.then(() => saveLocal(userId, next)).catch(() => undefined);
  }, [userId]);

  const update = useCallback(
    (fn: (prev: LocalState) => LocalState) => {
      const next = fn(stateRef.current);
      stateRef.current = next;
      setState(next);
      persist(next);
      return next;
    },
    [persist],
  );

  const refreshSnapshot = useCallback(async () => {
    const headers: HeadersInit = {};
    if (etagRef.current) headers["if-none-match"] = etagRef.current;
    const response = await fetch("/api/my/jobs", { headers });
    if (response.status === 401) {
      setNeedsSignIn(true);
      return;
    }
    if (response.status === 304) {
      lastSnapshot.current = Date.now();
      return;
    }
    if (!response.ok) {
      if (response.status === 429 || response.status >= 500) {
        attemptRef.current += 1;
      }
      if (stateRef.current.serverJobs.length === 0) setError("Couldn't load your jobs.");
      return;
    }
    const body = (await response.json()) as { userId?: string; serverTime?: string; jobs?: TechJob[] };
    if (body.userId && body.userId !== userId) {
      await wipeFieldData(userId);
      update(() => emptyState());
      setError("This phone had another person's jobs. They were removed.");
      return;
    }
    etagRef.current = response.headers.get("etag");
    lastSnapshot.current = Date.now();
    setError(null);
    update((prev) => replaceSnapshot(prev, Array.isArray(body.jobs) ? body.jobs : [], body.serverTime ?? new Date().toISOString(), userId));
  }, [update, userId]);

  const flushNow = useCallback(async (refresh = false) => {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setOffline(true);
      return;
    }
    setSyncing(true);
    try {
      // A snapshot on every flush would burn the hourly limit. Load, reconnect, and a five-minute gap refresh.
      if (refresh || Date.now() - lastSnapshot.current >= SNAPSHOT_GAP_MS) {
        try {
          await refreshSnapshot();
        } catch {
          // A failed refresh still lets queued ops try. They stay on the phone if the sync fails too.
        }
      }
      const batch = selectBatch(stateRef.current.outbox);
      if (batch.length === 0) {
        attemptRef.current = 0;
        return;
      }
      const response = await fetch("/api/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId: deviceId(), ops: batch.map(toSyncPayload) }),
      });
      const kind = classifyResponse(response.status);
      if (kind === "unauthorized") {
        setNeedsSignIn(true);
        return;
      }
      if (kind !== "ok") {
        setError("Couldn't sync. Your changes are still on this phone.");
        const delay = nextDelay(attemptRef.current);
        attemptRef.current += 1;
        window.setTimeout(() => void flushLockedRef.current(), delay);
        return;
      }
      const body = (await response.json()) as { results?: SyncResult[] };
      attemptRef.current = 0;
      setError(null);
      update((prev) => applyResults(prev, Array.isArray(body.results) ? body.results : [], new Date()));
      if (stateRef.current.outbox.length > 0) window.setTimeout(() => void flushLockedRef.current(), 2_000);
    } catch {
      setOffline(true);
      setError("Couldn't sync. Your changes are still on this phone.");
      const delay = nextDelay(attemptRef.current);
      attemptRef.current += 1;
      window.setTimeout(() => void flushLockedRef.current(), delay);
    } finally {
      setSyncing(false);
    }
  }, [refreshSnapshot, update]);

  const flushLocked = useCallback(async (refresh = false) => {
    if (flushing.current) return flushing.current;
    const run = (async () => {
      if (typeof navigator !== "undefined" && navigator.locks?.request) {
        await navigator.locks.request("fsd-flush", () => flushNow(refresh));
        return;
      }
      await flushNow(refresh);
    })();
    flushing.current = run.finally(() => {
      flushing.current = null;
    });
    return flushing.current;
  }, [flushNow]);

  useEffect(() => {
    flushLockedRef.current = flushLocked;
  }, [flushLocked]);

  const queueFlush = useCallback(() => {
    if (flushTimer.current != null) window.clearTimeout(flushTimer.current);
    flushTimer.current = window.setTimeout(() => {
      flushTimer.current = null;
      void flushLocked();
    }, 2_000);
  }, [flushLocked]);

  useEffect(() => {
    let cancel = false;
    const markOffline = window.setTimeout(() => {
      if (!cancel) setOffline(!navigator.onLine);
    }, 0);
    void (async () => {
      const loaded = await loadLocal(userId);
      if (cancel) return;
      if (shouldWipeSnapshot(loaded, userId, new Date())) {
        await wipeFieldData(userId);
        stateRef.current = emptyState();
      } else {
        stateRef.current = loaded.ownerId && loaded.ownerId !== userId ? emptyState() : loaded;
      }
      setState(stateRef.current);
      setReady(true);
      if (typeof navigator !== "undefined" && navigator.onLine) void flushLocked(true);
    })();
    return () => {
      cancel = true;
      window.clearTimeout(markOffline);
    };
  }, [userId, flushLocked]);

  useEffect(() => {
    const onOnline = () => {
      setOffline(false);
      void flushLocked(true);
    };
    const onOffline = () => setOffline(true);
    const onVisible = () => {
      if (document.visibilityState === "visible") void flushLocked();
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVisible);
    const interval = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (stateRef.current.outbox.length > 0) {
        void flushLocked();
        return;
      }
      if (navigator.onLine && Date.now() - lastSnapshot.current > SNAPSHOT_GAP_MS) void refreshSnapshot();
    }, 60_000);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(interval);
    };
  }, [flushLocked, refreshSnapshot]);

  const jobs = project(state);
  const groups = groupJobs(jobs, new Date());

  const addNote = useCallback(
    async (jobId: string, body: string) => {
      let message: string | null = null;
      update((prev) => {
        const result = enqueueNote(prev, jobId, body, crypto.randomUUID(), new Date());
        message = result.error;
        return result.error ? prev : result.state;
      });
      if (!message) queueFlush();
      return message;
    },
    [queueFlush, update],
  );

  const setStatus = useCallback(
    async (jobId: string, to: string, location?: OutboxOp["location"]) => {
      let message: string | null = null;
      update((prev) => {
        const result = enqueueStatus(prev, jobId, to, crypto.randomUUID(), new Date(), location);
        message = result.error;
        return result.error ? prev : result.state;
      });
      if (!message) queueFlush();
      return message;
    },
    [queueFlush, update],
  );

  const checkIn = useCallback(
    async (jobId: string) => {
      const location = await captureCheckIn();
      return setStatus(jobId, "on_site", location);
    },
    [setStatus],
  );

  const dismiss = useCallback(
    (id: string) => {
      update((prev) => dismissAttention(prev, id));
    },
    [update],
  );

  const loadWorkOrder = useCallback(async (jobId: string) => {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setWorkOrder(null);
      setWorkOrderError(null);
      return;
    }
    setWorkOrderPending(true);
    setWorkOrderError(null);
    try {
      const response = await fetch(`/api/jobs/${jobId}/work-order`);
      if (response.status === 404) {
        setWorkOrder(null);
        setWorkOrderError("That job isn't on your list.");
        return;
      }
      if (!response.ok) {
        setWorkOrderError("Couldn't load the work order.");
        return;
      }
      const body = (await response.json()) as { workOrder: WorkOrderView | null };
      setWorkOrder(body.workOrder);
    } catch {
      setWorkOrderError("Couldn't load the work order.");
    } finally {
      setWorkOrderPending(false);
    }
  }, []);

  const saveWorkOrder = useCallback(async (jobId: string, input: unknown) => {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setWorkOrderError("Work orders need a connection.");
      return;
    }
    setWorkOrderPending(true);
    setWorkOrderError(null);
    try {
      const response = await fetch(`/api/jobs/${jobId}/work-order`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      const body = (await response.json().catch(() => null)) as { workOrder?: WorkOrderView; error?: string } | null;
      if (!response.ok) {
        setWorkOrderError(body?.error ?? "Couldn't save the work order.");
        return;
      }
      if (body?.workOrder) setWorkOrder(body.workOrder);
    } catch {
      setWorkOrderError("Couldn't save the work order.");
    } finally {
      setWorkOrderPending(false);
    }
  }, []);

  return {
    ready,
    offline,
    error,
    needsSignIn,
    syncing,
    pendingCount: state.outbox.length,
    attention: state.attention,
    jobs,
    groups,
    syncingLabel: ready ? syncLabel({ offline, syncing, pending: state.outbox.length, attention: state.attention.length, needsSignIn }) : "Loading…",
    addNote,
    setStatus,
    checkIn,
    dismiss,
    retry: () => void flushLocked(true),
    workOrder,
    workOrderError,
    workOrderPending,
    loadWorkOrder,
    saveWorkOrder,
    countPendingOps,
  };
}
