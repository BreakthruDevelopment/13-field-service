/** What the phone sends is what the server accepts: every op the engine can queue passes the server's own parser. */
import { describe, expect, it, vi } from "vitest";
import { SYNC_MAX_OPS } from "@/lib/sync";
import { MAX_BATCH_OPS } from "./engine";
import { job, reply, rig, snapshotFor } from "./test-helpers";
import type { WireOp } from "./types";

describe("wire protocol", () => {
  it("the engine's ops all parse on the server, and the batch limit is the server's", async () => {
    const { parseOp } = await import("@/lib/sync");
    const sent: WireOp[] = [];
    const r = rig(vi, (url, init) => {
      if (url !== "/api/sync") return reply(200, { userId: "u", serverTime: "t", jobs: [job()], truncated: false });
      const ops = JSON.parse(String(init?.body)).ops as WireOp[];
      sent.push(...ops);
      return reply(200, { results: ops.map((o) => ({ opId: o.opId, outcome: "applied" })), serverTime: "t" });
    });
    const seed = await r.open("u");
    await (seed as unknown as { store: { putSnapshot: (s: unknown) => Promise<void>; close: () => void } }).store.putSnapshot(snapshotFor("u", [job()]));
    (seed as unknown as { store: { close: () => void } }).store.close();
    const engine = await r.open("u");
    await engine.load();
    const id = job().id;
    await engine.addNote(id, "Replaced the cartridge. é ü 日本語");
    await engine.setStatus(id, "en_route");
    await engine.setStatus(id, "on_site", { location: { lat: 30.2672, lng: -97.7431, accuracyM: 12.5, capturedAt: "2026-11-15T10:00:00.000Z" } });
    await engine.addNote(id, "done");
    await engine.setStatus(id, "completed");
    await engine.flush();
    expect(sent).toHaveLength(5);
    for (const op of sent) expect(parseOp(op), JSON.stringify(op)).not.toBeNull();
    expect(MAX_BATCH_OPS).toBe(SYNC_MAX_OPS);
  });
});
