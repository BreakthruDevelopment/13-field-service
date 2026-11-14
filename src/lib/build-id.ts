import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";

/** Keep cache names to a token. Anything else becomes `dev`, which still rotates when a real id appears. */
export function sanitizeBuildId(raw: string | null | undefined): string {
  const trimmed = (raw ?? "").trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(trimmed) ? trimmed : "dev";
}

/** The Next build id when this process was built. `dev` before the first production build. */
export function buildId(): string {
  const candidates = [path.join(process.cwd(), ".next", "BUILD_ID"), path.join(process.cwd(), "BUILD_ID")];
  for (const file of candidates) {
    try {
      return sanitizeBuildId(readFileSync(/*turbopackIgnore: true*/ file, "utf8"));
    } catch {
      // The file is absent in dev and in some standalone layouts.
    }
  }
  return "dev";
}
