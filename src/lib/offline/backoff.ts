/** Exponential backoff with full jitter: 2 s doubling to 5 min, never under 1 s (a retry storm helps nobody). */
export const BACKOFF_BASE_MS = 2000;
export const BACKOFF_MAX_MS = 5 * 60_000;
export const BACKOFF_MIN_MS = 1000;

export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt));
  return Math.max(BACKOFF_MIN_MS, Math.round(random() * ceiling));
}

/** `Retry-After` in seconds (an HTTP date is ignored), clamped to the backoff ceiling. */
export function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(BACKOFF_MAX_MS, Math.round(seconds * 1000));
}
