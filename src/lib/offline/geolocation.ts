import type { CheckInLocation } from "./types";

/**
 * The only place in the app that asks the browser for a location. It must be called from the click handler of the
 * explicit "Check in at site" button, one fix per tap: `watchPosition` is banned by ESLint and `getCurrentPosition` is
 * banned everywhere except this file (see `eslint.config.mjs`), and `Permissions-Policy` allows geolocation for this
 * origin only. Denied, unavailable or timed out gives `null` and the check-in goes ahead without a location.
 * The server keeps 4 decimals (about 11 m), clamps `capturedAt`, and labels the fix "device-reported".
 */
export const GEOLOCATION_TIMEOUT_MS = 15_000;
export const GEOLOCATION_MAX_AGE_MS = 60_000;
const MAX_ACCURACY_M = 10_000;

type GeoLike = Pick<Geolocation, "getCurrentPosition">;

export function captureCheckInLocation(geo: GeoLike | undefined = typeof navigator === "undefined" ? undefined : navigator.geolocation): Promise<CheckInLocation | null> {
  if (!geo) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      geo.getCurrentPosition(
        (pos) => {
          const { latitude, longitude, accuracy } = pos.coords;
          if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return resolve(null);
          resolve({
            lat: latitude,
            lng: longitude,
            accuracyM: Math.min(MAX_ACCURACY_M, Math.max(0, Number.isFinite(accuracy) ? accuracy : MAX_ACCURACY_M)),
            capturedAt: new Date(Number.isFinite(pos.timestamp) ? pos.timestamp : Date.now()).toISOString(),
          });
        },
        () => resolve(null),
        { enableHighAccuracy: true, timeout: GEOLOCATION_TIMEOUT_MS, maximumAge: GEOLOCATION_MAX_AGE_MS },
      );
    } catch {
      resolve(null);
    }
  });
}
