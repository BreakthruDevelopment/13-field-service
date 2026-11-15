import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NAV_LINKS } from "./app-config";

describe("navigation", () => {
  it("every nav link and every role's home page has a page file", () => {
    const hrefs = [...NAV_LINKS.map((l) => l.href), "/waiting", "/board", "/tech", "/admin", "/dashboard"];
    for (const href of new Set(hrefs)) {
      const file = path.join(__dirname, "..", "app", href, "page.tsx");
      expect(existsSync(file), `${href} has no src/app${href}/page.tsx`).toBe(true);
    }
  });
});
