/** Location is tap-only: the lint rule bans watchPosition everywhere and getCurrentPosition outside the one helper. */
import path from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const lint = async (code: string, file: string) => {
  const eslint = new ESLint({ cwd: root });
  const [result] = await eslint.lintText(code, { filePath: path.join(root, file) });
  return result.messages.filter((m) => m.ruleId === "no-restricted-properties");
};

describe("geolocation lint rule", () => {
  it("bans watchPosition everywhere, even in the helper", async () => {
    const code = "export const f = () => navigator.geolocation.watchPosition(() => {});";
    expect(await lint(code, "src/components/x.tsx")).toHaveLength(1);
    expect(await lint(code, "src/lib/offline/geolocation.ts")).toHaveLength(1);
  });
  it("allows getCurrentPosition only in the helper", async () => {
    const code = "export const f = () => navigator.geolocation.getCurrentPosition(() => {});";
    expect(await lint(code, "src/components/x.tsx")).toHaveLength(1);
    expect(await lint(code, "src/app/tech/page.tsx")).toHaveLength(1);
    expect(await lint(code, "src/lib/offline/geolocation.ts")).toHaveLength(0);
  });
}, 60_000);
