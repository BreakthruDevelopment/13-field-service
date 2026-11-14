"use client";

import { signOut } from "@/lib/auth/client";
import { countPendingOps, wipeFieldData } from "@/lib/offline/idb";

/** Warn when the outbox still has work, wipe this app's local data, then sign out. */
export async function signOutAndWipe(): Promise<"cancelled" | "ok" | "failed"> {
  const pending = await countPendingOps();
  if (pending > 0) {
    const noun = pending === 1 ? "change" : "changes";
    if (!window.confirm(`${pending} ${noun} not synced will be lost`)) return "cancelled";
  }
  await wipeFieldData();
  try {
    await fetch("/api/session/clear", { method: "POST" });
  } catch {
    // The phone copy is already gone. Sign-out still runs.
  }
  try {
    const result = await signOut();
    if (result.error) return "failed";
    return "ok";
  } catch {
    return "failed";
  }
}
