"use client";

import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { BOARD_POLL_MS, startVisiblePoll } from "@/lib/visible-poll";
import { BoardNotices } from "./board-notice";

/**
 * What the board needs around every card: the visible-tab poll, and the notice area that has to outlive a card.
 * Both sit above the job cards, so a refresh that removes a card leaves them standing.
 */
export function BoardShell({ children }: { children: ReactNode }) {
  return (
    <BoardPoller>
      <BoardNotices>{children}</BoardNotices>
    </BoardPoller>
  );
}

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
