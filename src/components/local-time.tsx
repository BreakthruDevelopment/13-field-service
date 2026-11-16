"use client";

import { useSyncExternalStore } from "react";
import { formatUtc } from "@/lib/field-format";

function subscribeClock() {
  return () => {};
}

function formatLocal(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

/** UTC during server render, then the viewer's local time. The `dateTime` attribute stays absolute. */
export function LocalTime({ iso }: { iso: string }) {
  const label = useSyncExternalStore(subscribeClock, () => formatLocal(iso), () => formatUtc(iso));
  return <time dateTime={iso}>{label}</time>;
}
