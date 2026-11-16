/**
 * The offline HTTP routes (13.2) with real Better Auth sessions: POST /api/sync, GET /api/my/jobs and POST
 * /api/session/clear. Who may call them, same-origin, body limits, NUL bytes, owner binding, rate limits, ETag/304 and
 * cache headers. The ledger and conflict rules are in sync.integration.test.ts.
 */
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { clean, setup, testDatabaseUrl, uuid, window } from "./fs-helpers";

process.env.LOG_LEVEL = "warn";
const holder = vi.hoisted(() => ({ cookie: "" }));
vi.mock("next/headers", () => ({ headers: async () => new Headers(holder.cookie ? { cookie: holder.cookie } : {}) }));

const P = "syr";
const ORIGIN = "http://localhost:3000";
const PASSWORD = "correct-horse-battery";

describe.skipIf(!testDatabaseUrl)("offline routes (Better Auth + Postgres)", () => {
  let sql: postgres.Sql;
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let syncRoute: typeof import("@/app/api/sync/route");
  let mineRoute: typeof import("@/app/api/my/jobs/route");
  let clearRoute: typeof import("@/app/api/session/clear/route");
  let jobId: string;

  async function signUp(name: string, role: string) {
    const { auth } = await import("@/lib/auth");
    const email = `${P}-${name}@test.local`;
    const call = (path: string, body: unknown) =>
      auth().handler(new Request(`${ORIGIN}/api/auth${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    const up = await call("/sign-up/email", { name, email, password: PASSWORD });
    expect(up.status).toBe(200);
    ids[name] = ((await up.json()) as { user: { id: string } }).user.id;
    await sql`update "user" set role = ${role} where id = ${ids[name]}`;
    const login = await call("/sign-in/email", { email, password: PASSWORD });
    cookies[name] = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  }

  async function post(who: string, route: { POST: (r: Request) => Promise<Response> }, body: unknown, opts: { origin?: string | null; raw?: string } = {}) {
    holder.cookie = who ? cookies[who] : "";
    const origin = opts.origin === undefined ? ORIGIN : opts.origin;
    const res = await route.POST(
      new Request(`${ORIGIN}/api/x`, {
        method: "POST",
        headers: { ...(origin ? { origin } : {}), "content-type": "application/json" },
        body: opts.raw ?? JSON.stringify(body),
      }),
    );
    const text = await res.text();
    return { status: res.status, headers: res.headers, json: text ? (JSON.parse(text) as Record<string, any>) : {} }; // eslint-disable-line @typescript-eslint/no-explicit-any
  }
  async function get(who: string, headers: Record<string, string> = {}) {
    holder.cookie = who ? cookies[who] : "";
    const res = await mineRoute.GET(new Request(`${ORIGIN}/api/my/jobs`, { headers }));
    const text = await res.text();
    return { status: res.status, headers: res.headers, json: text ? (JSON.parse(text) as Record<string, any>) : {} }; // eslint-disable-line @typescript-eslint/no-explicit-any
  }
  const note = (id: string, body = "from the route") => ({ kind: "note.add", opId: uuid(), jobId: id, clientAt: new Date().toISOString(), body });

  beforeAll(async () => {
    const s = await setup(P, {});
    sql = s.sql;
    syncRoute = await import("@/app/api/sync/route");
    mineRoute = await import("@/app/api/my/jobs/route");
    clearRoute = await import("@/app/api/session/clear/route");
    for (const [name, role] of [["admin", "admin"], ["disp", "dispatcher"], ["tech", "technician"], ["tech2", "technician"], ["newbie", "user"]] as const) await signUp(name, role);
    const customers = await import("@/lib/customers");
    const jobs = await import("@/lib/service-jobs");
    const disp = { id: ids.disp, role: "dispatcher" as const };
    const c = (await customers.createCustomer(disp, { name: "Route Co", phone: "555-0199", email: "boss@route.example" })).customer;
    const site = (await customers.createSite(disp, c.id, { label: "HQ", address: "9 Route Rd" })).site;
    jobId = (await jobs.createJob(disp, { customerId: c.id, siteId: site.id, title: "Route job", assigneeId: ids.tech, ...window() })).job.id;
  });

  afterAll(async () => {
    await clean(sql, P);
    await sql.end();
  });

  describe("POST /api/sync", () => {
    it("401 signed out; 403 for a plain user, a dispatcher and an admin; nothing is written", async () => {
      const body = { ownerId: ids.tech, ops: [note(jobId)] };
      expect((await post("", syncRoute, body)).status).toBe(401);
      for (const who of ["newbie", "disp", "admin"]) expect((await post(who, syncRoute, { ownerId: ids[who], ops: [note(jobId)] })).status, who).toBe(403);
      expect((await sql`select count(*)::int as n from job_note where job_id = ${jobId}`)[0].n).toBe(0);
    });

    it("refuses another origin and a missing Origin (403), malformed JSON and NUL bytes (400), and a body over 64 KB (413)", async () => {
      const body = { ownerId: ids.tech, ops: [note(jobId)] };
      expect((await post("tech", syncRoute, body, { origin: "https://evil.example" })).status).toBe(403);
      expect((await post("tech", syncRoute, body, { origin: null })).status).toBe(403);
      expect((await post("tech", syncRoute, null, { raw: "{nope" })).status).toBe(400);
      expect((await post("tech", syncRoute, { ownerId: ids.tech, ops: [note(jobId, "nul\u0000byte")] })).status).toBe(400);
      expect((await post("tech", syncRoute, null, { raw: JSON.stringify({ ownerId: ids.tech, pad: "x".repeat(70_000) }) })).status).toBe(413);
      expect((await sql`select count(*)::int as n from job_note where job_id = ${jobId}`)[0].n).toBe(0);
    });

    it("the owner must match the session user: a device holding another account's data gets 409 owner_mismatch and nothing is applied", async () => {
      const res = await post("tech", syncRoute, { ownerId: ids.tech2, ops: [note(jobId)] });
      expect(res.status).toBe(409);
      expect(res.json.code).toBe("owner_mismatch");
      expect((await sql`select count(*)::int as n from job_note where job_id = ${jobId}`)[0].n).toBe(0);
    });

    it("applies a batch, answers per op, never caches, and a replay returns the same", async () => {
      const ops = [note(jobId, "first"), note(uuid(), "a job that isn't mine")];
      const res = await post("tech", syncRoute, { ownerId: ids.tech, deviceId: "phone-1", ops });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.json.results.map((r: { outcome: string; code?: string }) => [r.outcome, r.code])).toEqual([["applied", undefined], ["rejected", "not_assigned"]]);
      expect(typeof res.json.serverTime).toBe("string");
      const again = await post("tech", syncRoute, { ownerId: ids.tech, ops });
      expect(again.json.results.map((r: { outcome: string }) => r.outcome)).toEqual(["replayed", "rejected"]);
      expect((await sql`select count(*)::int as n from job_note where job_id = ${jobId}`)[0].n).toBe(1);
      expect((await sql`select device_id from sync_op where actor_id = ${ids.tech} limit 1`)[0].device_id).toBe("phone-1");
    });

    it("another technician posting this technician's op for their own account can't touch the job", async () => {
      const res = await post("tech2", syncRoute, { ownerId: ids.tech2, ops: [note(jobId, "not yours")] });
      expect(res.json.results[0]).toMatchObject({ outcome: "rejected", code: "not_assigned" });
      expect((await sql`select count(*)::int as n from job_note where body = 'not yours'`)[0].n).toBe(0);
    });

    it("over 30 flushes an hour is a 429 with Retry-After, and the response carries nothing else", async () => {
      await sql`delete from rate_event where user_id = ${ids.tech2}`;
      await sql`insert into rate_event (user_id, kind) select ${ids.tech2}, 'sync' from generate_series(1, 30)`;
      const res = await post("tech2", syncRoute, { ownerId: ids.tech2, ops: [note(jobId)] });
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("120");
      expect(res.json.results).toBeUndefined();
    });
  });

  describe("GET /api/my/jobs", () => {
    it("401 signed out; 403 for a plain user, a dispatcher and an admin", async () => {
      expect((await get("")).status).toBe(401);
      for (const who of ["newbie", "disp", "admin"]) expect((await get(who)).status, who).toBe(403);
    });

    it("returns the technician's snapshot with no-store and an ETag; a matching If-None-Match is a 304 with no body", async () => {
      const res = await get("tech");
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.json.userId).toBe(ids.tech);
      expect(res.json.jobs.map((j: { id: string }) => j.id)).toEqual([jobId]);
      expect(JSON.stringify(res.json)).not.toContain("boss@route.example");
      const etag = res.headers.get("etag")!;
      expect(etag).toMatch(/^W\//);
      const same = await get("tech", { "if-none-match": etag });
      expect(same.status).toBe(304);
      expect(same.json).toEqual({});
      expect((await get("tech", { "if-none-match": 'W/"stale"' })).status).toBe(200);
      // Another technician's snapshot never matches this one's tag.
      expect((await get("tech2", { "if-none-match": etag })).status).toBe(200);
    });
  });

  describe("POST /api/session/clear", () => {
    it("answers Clear-Site-Data for cache and storage (and not cookies), with no session needed", async () => {
      const res = await post("", clearRoute, {});
      expect(res.status).toBe(204);
      expect(res.headers.get("clear-site-data")).toBe('"cache", "storage"');
      expect(res.headers.get("cache-control")).toBe("no-store");
    });

    it("refuses another origin", async () => {
      const res = await post("", clearRoute, {}, { origin: "https://evil.example" });
      expect(res.status).toBe(403);
      expect(res.headers.get("clear-site-data")).toBeNull();
    });
  });
});
