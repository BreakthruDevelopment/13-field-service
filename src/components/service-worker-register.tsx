"use client";

import { useEffect } from "react";
import { finishPendingSignOut } from "@/lib/offline/browser";

/**
 * Registers `/sw.js` for the technician area only (`scope: "/tech"`). The build id in the query makes every build a new
 * script URL, so a deploy updates the worker (and `activate` deletes the old build's caches).
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const build = process.env.NEXT_PUBLIC_BUILD_ID ?? "dev";
    navigator.serviceWorker.register(`/sw.js?v=${encodeURIComponent(build)}`, { scope: "/tech", updateViaCache: "none" }).catch(() => undefined);
  }, []);
  return null;
}

/** Finishes a sign-out that was done offline (the local wipe happened then; the server session ends now). Renders nothing. */
export function PendingSignOut() {
  useEffect(() => {
    void finishPendingSignOut().catch(() => undefined);
    const onOnline = () => void finishPendingSignOut().catch(() => undefined);
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, []);
  return null;
}
