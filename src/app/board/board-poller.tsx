"use client";

import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { BOARD_POLL_MS, startVisiblePoll } from "@/lib/visible-poll";

/** Refreshes the board every 60 s while this tab is visible. Hidden tabs don't poll. */
export function BoardPoller({ children }: { children: ReactNode }) {
  const router = useRouter();
  useEffect(() => {
    return startVisiblePoll(() => router.refresh(), {
      setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
      clearInterval: (id: ReturnType<typeof setInterval>) => globalThis.clearInterval(id),
      document,
    }, BOARD_POLL_MS);
  }, [router]);
  return children;
}
