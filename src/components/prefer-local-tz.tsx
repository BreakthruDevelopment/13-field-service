"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { isTimeZone, todayInTimeZone } from "@/lib/job-display";

/** First visit without `tz` in the URL: use the browser's IANA zone so times match the shop clock. */
export function PreferLocalTz({ path, withDate = false }: { path: string; withDate?: boolean }) {
  const router = useRouter();
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("tz")) return;
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!isTimeZone(local)) return;
    if (withDate && !params.get("date")) params.set("date", todayInTimeZone(local));
    params.set("tz", local);
    router.replace(`${path}?${params.toString()}`);
  }, [path, router, withDate]);
  return null;
}
