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
    const container = navigator.serviceWorker;
    const build = process.env.NEXT_PUBLIC_BUILD_ID ?? "dev";
    // The worker answers a warm-up with `warmed`. `html[data-offline-ready="1"]` and the `fsd:offline-ready` event say the
    // shell AND every file the page loaded are saved, so the app opens offline from now on (13.6 may show a chip). If
    // something couldn't be saved (the connection dropped half way) the page asks again after a pause and when it is back online.
    let attempts = 0;
    let ready = false;
    let timer: number | undefined;
    const warm = async () => {
      try {
        const registration = await container.ready;
        // On a first visit this page isn't controlled by the worker, so it never saw our requests: hand it the list of
        // files this page loaded (they come from the browser's own cache) and have it save the shell.
        const urls = performance.getEntriesByType("resource").map((e) => e.name).filter((n) => n.includes("/_next/static/"));
        registration.active?.postMessage({ type: "warm", urls });
      } catch {
        // no worker: the app still works online
      }
    };
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== "warmed") return;
      ready = Boolean(event.data.ready);
      document.documentElement.dataset.offlineReady = ready ? "1" : "0";
      window.dispatchEvent(new CustomEvent("fsd:offline-ready", { detail: { ready } }));
      if (!ready && attempts < 4) {
        attempts += 1;
        window.clearTimeout(timer);
        timer = window.setTimeout(() => void warm(), 5000 * attempts);
      }
    };
    const onOnline = () => {
      if (!ready) void warm();
    };
    container.addEventListener("message", onMessage);
    window.addEventListener("online", onOnline);
    let cancelled = false;
    void (async () => {
      try {
        await container.register(`/sw.js?v=${encodeURIComponent(build)}`, { scope: "/tech", updateViaCache: "none" });
        if (document.readyState !== "complete") await new Promise((resolve) => window.addEventListener("load", resolve, { once: true }));
        if (!cancelled) await warm();
      } catch {
        // no service worker (private mode, unsupported): the app still works online
      }
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      container.removeEventListener("message", onMessage);
      window.removeEventListener("online", onOnline);
    };
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
