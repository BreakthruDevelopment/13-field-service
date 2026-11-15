import { z } from "zod";

/**
 * Check-in location rules (decision D6). The browser sends a location only from the explicit "Check in at site" tap; the
 * server keeps it to 4 decimal places (about 11 m), clamps the device's clock, and never trusts it: it is labelled
 * "device-reported" everywhere. Coordinates are nulled 90 days after the job closes (`src/lib/maintenance.ts`).
 */
export const CAPTURED_AT_CLAMP_MS = 7 * 24 * 3600_000;
export const LATE_AFTER_MS = 10 * 60_000;
export const LOCATION_RETENTION_DAYS = 90;

export const locationInput = z
  .object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    accuracyM: z.number().min(0).max(10_000),
    capturedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type LocationInput = z.infer<typeof locationInput>;

export type StoredLocation = { lat: string; lng: string; accuracyM: number; capturedAt: Date; late: boolean };

const round4 = (n: number) => (Math.round(n * 1e4) / 1e4).toFixed(4);

/**
 * Round to 4 decimals, clamp `capturedAt` into [now - 7 days, now] (a device clock in the future is treated as "now"),
 * and flag the fix `late` when it is more than 10 minutes old.
 */
export function normalizeLocation(input: LocationInput, now: Date = new Date()): StoredLocation {
  const claimed = new Date(input.capturedAt).getTime();
  const capturedAt = new Date(Math.min(now.getTime(), Math.max(now.getTime() - CAPTURED_AT_CLAMP_MS, claimed)));
  return {
    lat: round4(input.lat),
    lng: round4(input.lng),
    accuracyM: Math.round(input.accuracyM),
    capturedAt,
    late: now.getTime() - capturedAt.getTime() > LATE_AFTER_MS,
  };
}

/** Great-circle distance in metres (haversine). */
export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(h))));
}
