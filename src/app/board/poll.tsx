"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Refresh the board every 60 seconds, and only while this tab is visible. */
export function BoardPoll() {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, 60_000);
    return () => clearInterval(id);
  }, [router]);
  return null;
}
