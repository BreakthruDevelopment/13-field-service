/**
 * The HTTP layer, against a real Postgres and real Better Auth sessions: status codes per role, same-origin, body
 * limits, NUL bytes, idempotent creates, version conflicts, the id-guessing 404s, and that roles change only through
 * POST /api/admin/roles. `next/headers` is replaced so route handlers see the cookie of whoever the test "is".
 */
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { clean, setup, testDatabaseUrl, uuid, window } from "./fs-helpers";

const holder = vi.hoisted(() => ({ cookie: "" }));
vi.mock("next/headers", () => ({ headers: async () => new Headers(holder.cookie ? { cookie: holder.cookie } : {}) }));

const P = "rte";
const ORIGIN = "http://localhost:3000";
const PASSWORD = "correct-horse-battery";

describe.skipIf(!testDatabaseUrl)("API routes (Better Auth + Postgres)", () => {
  let sql: postgres.Sql;
  let authHandler: (req: Request) => Promise<Response>;
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let customerId: string, siteId: string;

  async function authCall(path: string, body: unknown, cookie?: string) {
    return authHandler(
      new Request(`${ORIGIN}/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body),
      }),
    );
  }
  async function signUp(name: string, extra: object = {}) {
    const email = `${P}-${name}@test.local`;
    const res = await authCall("/sign-up/email", { name, email, password: PASSWORD, ...extra });
    expect(res.status).toBe(200);
    ids[name] = ((await res.json()) as { user: { id: string } }).user.id;
    const login = await authCall("/sign-in/email", { email, password: PASSWORD });
    expect(login.status).toBe(200);
    cookies[name] = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  }
  const roleOf = async (name: string) => (await sql`select role from "user" where id = ${ids[name]}`)[0].role as string;

  /** Call a route handler as `who` ("" = signed out). */
  async function call(who: string, handler: (req: Request, ctx: never) => Promise<Response>, method: string, url: string, body?: unknown, opts: { origin?: string | null; raw?: string; ctx?: unknown } = {}) {
    holder.cookie = who ? cookies[who] : "";
    const origin = opts.origin === undefined ? ORIGIN : opts.origin;
    const res = await (handler as (req: Request, ctx?: unknown) => Promise<Response>)(
      new Request(`${ORIGIN}${url}`, {
        method,
        headers: { ...(origin ? { origin } : {}), ...(body !== undefined || opts.raw !== undefined ? { "content-type": "application/json" } : {}) },
        ...(opts.raw !== undefined ? { body: opts.raw } : body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
      opts.ctx,
    );
    const text = await res.text();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, json: text ? (JSON.parse(text) as Record<string, any>) : {} };
  }
  const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });

  let jobsRoute: typeof import("@/app/api/jobs/route");
  let jobRoute: typeof import("@/app/api/jobs/[id]/route");
  let notesRoute: typeof import("@/app/api/jobs/[id]/notes/route");
  let customersRoute: typeof import("@/app/api/customers/route");
  let customerRoute: typeof import("@/app/api/customers/[id]/route");
  let sitesRoute: typeof import("@/app/api/customers/[id]/sites/route");
  let siteRoute: typeof import("@/app/api/sites/[id]/route");
  let boardRoute: typeof import("@/app/api/board/route");
  let partsRoute: typeof import("@/app/api/parts/route");
  let partRoute: typeof import("@/app/api/parts/[id]/route");
  let statsRoute: typeof import("@/app/api/admin/stats/route");
  let usersRoute: typeof import("@/app/api/admin/users/route");
  let rolesRoute: typeof import("@/app/api/admin/roles/route");

  beforeAll(async () => {
    const s = await setup(P, {});
    sql = s.sql;
    const { auth } = await import("@/lib/auth");
    authHandler = auth().handler;
    jobsRoute = await import("@/app/api/jobs/route");
    jobRoute = await import("@/app/api/jobs/[id]/route");
    notesRoute = await import("@/app/api/jobs/[id]/notes/route");
    customersRoute = await import("@/app/api/customers/route");
    customerRoute = await import("@/app/api/customers/[id]/route");
    sitesRoute = await import("@/app/api/customers/[id]/sites/route");
    siteRoute = await import("@/app/api/sites/[id]/route");
    boardRoute = await import("@/app/api/board/route");
    partsRoute = await import("@/app/api/parts/route");
    partRoute = await import("@/app/api/parts/[id]/route");
    statsRoute = await import("@/app/api/admin/stats/route");
    usersRoute = await import("@/app/api/admin/users/route");
    rolesRoute = await import("@/app/api/admin/roles/route");

    for (const name of ["admin", "disp", "tech1", "tech2", "newbie"]) await signUp(name);
    await sql`update "user" set role = 'admin' where id = ${ids.admin}`;
    await sql`update "user" set role = 'dispatcher' where id = ${ids.disp}`;
    await sql`update "user" set role = 'technician' where id in (${ids.tech1}, ${ids.tech2})`;

    const c = await call("disp", customersRoute.POST, "POST", "/api/customers", { name: "Route Co", phone: "555-0199", email: "boss@route.example" });
    customerId = c.json.customer.id;
    siteId = (await call("disp", sitesRoute.POST, "POST", `/api/customers/${customerId}/sites`, { label: "HQ", address: "9 Route Rd" }, { ctx: idCtx(customerId) })).json.site.id;
  });

  afterAll(async () => {
    await clean(sql, P);
    await sql.end();
  });

  describe("sign-up and roles", () => {
    it("a sign-up that asks for a role never gets it: it is refused, or the account is a plain `user`", async () => {
      for (const role of ["admin", "dispatcher", "technician"]) {
        const email = `${P}-grab-${role}@test.local`;
        const res = await authCall("/sign-up/email", { name: `grab ${role}`, email, password: PASSWORD, role });
        const rows = await sql`select role from "user" where email = ${email}`;
        if (res.status === 200) expect(rows[0].role).toBe("user");
        else expect(rows).toHaveLength(0);
      }
      expect((await sql`select count(*)::int as n from "user" where email like ${`${P}-grab-%`} and role <> 'user'`)[0].n).toBe(0);
    });

    it("a signed-in user can't give themselves a role through /update-user either", async () => {
      await signUp("selfpromote");
      for (const role of ["admin", "dispatcher", "technician"]) {
        await authCall("/update-user", { role, name: "Still Me" }, cookies.selfpromote);
        expect(await roleOf("selfpromote")).toBe("user");
      }
    });

    it("a new sign-up gets 403 on every role-gated route", async () => {
      const probes: [string, Promise<{ status: number }>][] = [
        ["jobs list", call("newbie", jobsRoute.GET, "GET", "/api/jobs")],
        ["jobs create", call("newbie", jobsRoute.POST, "POST", "/api/jobs", { customerId, siteId, title: "x" })],
        ["customers", call("newbie", customersRoute.GET, "GET", "/api/customers")],
        ["parts", call("newbie", partsRoute.GET, "GET", "/api/parts")],
        ["board", call("newbie", boardRoute.GET, "GET", "/api/board?date=2026-11-15")],
        ["stats", call("newbie", statsRoute.GET, "GET", "/api/admin/stats")],
        ["roles", call("newbie", rolesRoute.POST, "POST", "/api/admin/roles", { userId: ids.newbie, role: "dispatcher", from: "user" })],
      ];
      for (const [name, p] of probes) expect((await p).status, name).toBe(403);
      expect(await roleOf("newbie")).toBe("user");
    });

    it("signed-out callers get 401", async () => {
      expect((await call("", jobsRoute.GET, "GET", "/api/jobs")).status).toBe(401);
      expect((await call("", jobsRoute.POST, "POST", "/api/jobs", {})).status).toBe(401);
      expect((await call("", rolesRoute.POST, "POST", "/api/admin/roles", {})).status).toBe(401);
      expect((await call("", boardRoute.GET, "GET", "/api/board?date=2026-11-15")).status).toBe(401);
    });

    it("Better Auth's own role and user-write endpoints are disabled for an admin and change nothing", async () => {
      for (const [path, body] of [
        ["/admin/set-role", { userId: ids.newbie, role: "dispatcher" }],
        ["/admin/create-user", { name: "x", email: `${P}-made@test.local`, password: PASSWORD, role: "dispatcher" }],
        ["/admin/update-user", { userId: ids.newbie, data: { name: "Renamed" } }],
        ["/admin/remove-user", { userId: ids.newbie }],
      ] as const) {
        const res = await authCall(path, body, cookies.admin);
        expect([403, 404], path).toContain(res.status);
      }
      expect(await roleOf("newbie")).toBe("user");
      expect((await sql`select count(*)::int as n from "user" where email = ${`${P}-made@test.local`}`)[0].n).toBe(0);
      expect((await sql`select count(*)::int as n from "user" where id = ${ids.newbie}`)[0].n).toBe(1);
    });
  });

  describe("POST /api/admin/roles", () => {
    it("grants and revokes roles for admins only, takes effect at once, and refuses `admin` and admin targets", async () => {
      const grant = (userId: string, role: string, from: string, who = "admin", opts = {}) => call(who, rolesRoute.POST, "POST", "/api/admin/roles", { userId, role, from }, opts);
      expect((await grant(ids.newbie, "technician", "user", "disp")).status).toBe(403);
      expect((await grant(ids.newbie, "technician", "user", "admin", { origin: "https://evil.example" })).status).toBe(403);
      expect((await grant(ids.newbie, "technician", "user", "admin", { origin: null })).status).toBe(403);
      expect(await roleOf("newbie")).toBe("user");

      expect((await call("newbie", jobsRoute.GET, "GET", "/api/jobs")).status).toBe(403);
      const ok = await grant(ids.newbie, "technician", "user");
      expect(ok.status).toBe(200);
      expect(ok.json).toMatchObject({ user: { id: ids.newbie, role: "technician" }, unassignedJobs: 0 });
      expect((await call("newbie", jobsRoute.GET, "GET", "/api/jobs")).status).toBe(200);

      expect((await grant(ids.newbie, "admin", "technician")).status).toBe(400);
      expect((await grant(ids.newbie, "superuser", "technician")).status).toBe(400);
      expect((await grant(ids.admin, "user", "admin")).status).toBe(409);
      expect((await grant("nobody", "user", "user")).status).toBe(404);
      expect((await call("admin", rolesRoute.POST, "POST", "/api/admin/roles", { userId: ids.newbie, role: "user", from: "technician", extra: 1 })).status).toBe(400);
      expect(await roleOf("admin")).toBe("admin");
    });

    it("applies only if the role still equals `from`: a stale retry after a concurrent change is a 409 and changes nothing", async () => {
      const post = (body: object) => call("admin", rolesRoute.POST, "POST", "/api/admin/roles", body);
      await sql`update "user" set role = 'user' where id = ${ids.newbie}`;
      const clientOpId = uuid();
      const first = await post({ userId: ids.newbie, role: "technician", from: "user", clientOpId });
      expect(first.status).toBe(200);
      expect(first.json.replayed).toBe(false);
      // Another admin revokes while the first response is lost...
      await sql`update "user" set role = 'user' where id = ${ids.newbie}`;
      // ...an exact replay returns the first result and does NOT restore access.
      const replay = await post({ userId: ids.newbie, role: "technician", from: "user", clientOpId });
      expect(replay.status).toBe(200);
      expect(replay.json).toMatchObject({ replayed: true, user: { id: ids.newbie, role: "technician" } });
      expect(await roleOf("newbie")).toBe("user");
      // A fresh retry (no op id, or a new one) with the stale `from` is refused with the current role.
      for (const extra of [{}, { clientOpId: uuid() }]) {
        await sql`update "user" set role = 'dispatcher' where id = ${ids.newbie}`;
        const stale = await post({ userId: ids.newbie, role: "technician", from: "user", ...extra });
        expect(stale.status).toBe(409);
        expect(stale.json.current).toEqual({ userId: ids.newbie, role: "dispatcher" });
        expect(await roleOf("newbie")).toBe("dispatcher");
      }
      expect((await post({ userId: ids.newbie, role: "technician" })).status).toBe(400); // `from` is required
      // The replay ledger: one row per op id, and parallel duplicates make one change.
      const par = uuid();
      await sql`update "user" set role = 'user' where id = ${ids.newbie}`;
      const rs = await Promise.all([1, 2, 3].map(() => post({ userId: ids.newbie, role: "technician", from: "user", clientOpId: par })));
      expect(rs.every((r) => r.status === 200)).toBe(true);
      expect(rs.filter((r) => r.json.replayed === false)).toHaveLength(1);
      expect((await sql`select count(*)::int as n from role_change_op where client_op_id = ${par}`)[0].n).toBe(1);
      await sql`update "user" set role = 'user' where id = ${ids.newbie}`;
    });

    it("revoking technician returns their open jobs to the unassigned tray in the same step", async () => {
      await sql`update "user" set role = 'technician' where id = ${ids.newbie}`;
      const mk = async () => (await call("disp", jobsRoute.POST, "POST", "/api/jobs", { customerId, siteId, title: "To be freed", assigneeId: ids.newbie, ...window() })).json.job;
      const a = await mk();
      const b = await mk();
      expect((await call("admin", rolesRoute.POST, "POST", "/api/admin/roles", { userId: ids.newbie, role: "user", from: "technician" })).json).toMatchObject({ unassignedJobs: 2 });
      for (const j of [a, b]) {
        const after = (await call("disp", jobRoute.GET, "GET", `/api/jobs/${j.id}`, undefined, { ctx: idCtx(j.id) })).json.job;
        expect(after).toMatchObject({ status: "unassigned", assignee: null, version: j.version + 1, statusVersion: j.statusVersion + 1 });
      }
      expect((await call("newbie", jobsRoute.GET, "GET", "/api/jobs")).status).toBe(403);
    });
  });

  describe("dispatcher routes", () => {
    it("creates jobs idempotently: a retry with the same clientOpId is 200 with the same job, and there is one row", async () => {
      const clientOpId = uuid();
      const first = await call("disp", jobsRoute.POST, "POST", "/api/jobs", { customerId, siteId, title: "Retry me", clientOpId });
      const again = await call("disp", jobsRoute.POST, "POST", "/api/jobs", { customerId, siteId, title: "Retry me", clientOpId });
      expect([first.status, again.status]).toEqual([201, 200]);
      expect(again.json.job.id).toBe(first.json.job.id);
      expect((await sql`select count(*)::int as n from service_job where client_op_id = ${clientOpId}`)[0].n).toBe(1);
    });

    it("refuses cross-origin and origin-less writes, bad JSON, NUL bytes and oversized bodies", async () => {
      const body = { customerId, siteId, title: "x" };
      expect((await call("disp", jobsRoute.POST, "POST", "/api/jobs", body, { origin: "https://evil.example" })).status).toBe(403);
      expect((await call("disp", jobsRoute.POST, "POST", "/api/jobs", body, { origin: null })).status).toBe(403);
      expect((await call("disp", jobsRoute.POST, "POST", "/api/jobs", undefined, { raw: "{nope" })).status).toBe(400);
      expect((await call("disp", jobsRoute.POST, "POST", "/api/jobs", { ...body, title: "nul\u0000byte" })).status).toBe(400);
      expect((await call("disp", customersRoute.POST, "POST", "/api/customers", { name: "n\u0000", phone: "1" })).status).toBe(400);
      expect((await call("disp", partsRoute.POST, "POST", "/api/parts", { sku: "TST-RTE-NUL", name: "n\u0000" })).status).toBe(400);
      expect((await call("disp", jobsRoute.GET, "GET", "/api/jobs?q=a%00b")).status).toBe(400);
      expect((await call("disp", jobsRoute.POST, "POST", "/api/jobs", undefined, { raw: JSON.stringify({ ...body, title: "x".repeat(40_000) }) })).status).toBe(413);
      expect((await call("disp", jobsRoute.POST, "POST", "/api/jobs", { ...body, title: "" })).status).toBe(400);
    });

    it("answers a stale version with 409 and the current job, and a stale site, customer and part the same way", async () => {
      const job = (await call("disp", jobsRoute.POST, "POST", "/api/jobs", { customerId, siteId, title: "Conflict" })).json.job;
      const ok = await call("disp", jobRoute.PATCH, "PATCH", `/api/jobs/${job.id}`, { op: "edit", version: job.version, title: "Conflict 2" }, { ctx: idCtx(job.id) });
      expect(ok.status).toBe(200);
      const stale = await call("disp", jobRoute.PATCH, "PATCH", `/api/jobs/${job.id}`, { op: "edit", version: job.version, title: "Conflict 3" }, { ctx: idCtx(job.id) });
      expect(stale.status).toBe(409);
      expect(stale.json.current.title).toBe("Conflict 2");
      const c = (await call("disp", customerRoute.GET, "GET", `/api/customers/${customerId}`, undefined, { ctx: idCtx(customerId) })).json;
      const upd = await call("disp", customerRoute.PATCH, "PATCH", `/api/customers/${customerId}`, { version: c.customer.version, notes: "n1" }, { ctx: idCtx(customerId) });
      expect(upd.status).toBe(200);
      expect((await call("disp", customerRoute.PATCH, "PATCH", `/api/customers/${customerId}`, { version: c.customer.version, notes: "n2" }, { ctx: idCtx(customerId) })).status).toBe(409);
      const s = c.sites[0];
      expect((await call("disp", siteRoute.PATCH, "PATCH", `/api/sites/${s.id}`, { version: s.version, label: "HQ 2" }, { ctx: idCtx(s.id) })).status).toBe(200);
      expect((await call("disp", siteRoute.PATCH, "PATCH", `/api/sites/${s.id}`, { version: s.version, label: "HQ 3" }, { ctx: idCtx(s.id) })).status).toBe(409);
      const p = (await call("disp", partsRoute.POST, "POST", "/api/parts", { sku: "TST-RTE-PART", name: "Route part" })).json.part;
      expect((await call("disp", partRoute.PATCH, "PATCH", `/api/parts/${p.id}`, { version: p.version, name: "Route part 2" }, { ctx: idCtx(p.id) })).status).toBe(200);
      expect((await call("disp", partRoute.PATCH, "PATCH", `/api/parts/${p.id}`, { version: p.version, name: "Route part 3" }, { ctx: idCtx(p.id) })).status).toBe(409);
      expect((await call("disp", partsRoute.POST, "POST", "/api/parts", { sku: "TST-RTE-PART", name: "Dupe" })).status).toBe(409);
    });

    it("explains a refused status move with a stable code", async () => {
      const job = (await call("disp", jobsRoute.POST, "POST", "/api/jobs", { customerId, siteId, title: "Rules" })).json.job;
      const res = await call("disp", jobRoute.PATCH, "PATCH", `/api/jobs/${job.id}`, { op: "status", version: job.version, to: "completed" }, { ctx: idCtx(job.id) });
      expect(res.status).toBe(409);
      expect(res.json.code).toBe("transition_not_allowed");
    });

    it("serves the board", async () => {
      const res = await call("disp", boardRoute.GET, "GET", "/api/board?date=2026-11-15&tz=America/Chicago");
      expect(res.status).toBe(200);
      expect(Object.keys(res.json).sort()).toEqual(["date", "jobs", "serverTime", "technicians", "truncated", "tz", "unassigned"]);
      expect((await call("disp", boardRoute.GET, "GET", "/api/board")).status).toBe(400);
    });
  });

  describe("technician routes", () => {
    it("sees only their own jobs; another technician's job id, an unassigned one and a made-up one are all 404", async () => {
      const mine = (await call("disp", jobsRoute.POST, "POST", "/api/jobs", { customerId, siteId, title: "Mine", assigneeId: ids.tech1, ...window() })).json.job;
      const theirs = (await call("disp", jobsRoute.POST, "POST", "/api/jobs", { customerId, siteId, title: "Theirs", assigneeId: ids.tech2, ...window() })).json.job;
      const tray = (await call("disp", jobsRoute.POST, "POST", "/api/jobs", { customerId, siteId, title: "Tray" })).json.job;

      const list = await call("tech1", jobsRoute.GET, "GET", "/api/jobs");
      expect(list.json.jobs.map((j: { id: string }) => j.id)).toEqual([mine.id]);
      const own = await call("tech1", jobRoute.GET, "GET", `/api/jobs/${mine.id}`, undefined, { ctx: idCtx(mine.id) });
      expect(own.status).toBe(200);
      expect(JSON.stringify(own.json)).not.toContain("boss@route.example");
      const bodies = [];
      for (const id of [theirs.id, tray.id, uuid()]) {
        const r = await call("tech1", jobRoute.GET, "GET", `/api/jobs/${id}`, undefined, { ctx: idCtx(id) });
        expect(r.status).toBe(404);
        bodies.push(JSON.stringify(r.json));
        const n = await call("tech1", notesRoute.POST, "POST", `/api/jobs/${id}/notes`, { body: "sneaky" }, { ctx: idCtx(id) });
        expect(n.status).toBe(404);
      }
      expect(new Set(bodies).size).toBe(1); // the same answer, so ids can't be told apart
      const note = await call("tech1", notesRoute.POST, "POST", `/api/jobs/${mine.id}/notes`, { body: "On my way", opId: uuid() }, { ctx: idCtx(mine.id) });
      expect(note.status).toBe(201);
    });

    it("can't use dispatcher routes", async () => {
      expect((await call("tech1", jobsRoute.POST, "POST", "/api/jobs", { customerId, siteId, title: "x" })).status).toBe(403);
      expect((await call("tech1", customersRoute.GET, "GET", "/api/customers")).status).toBe(403);
      expect((await call("tech1", customerRoute.GET, "GET", `/api/customers/${customerId}`, undefined, { ctx: idCtx(customerId) })).status).toBe(403);
      expect((await call("tech1", boardRoute.GET, "GET", "/api/board?date=2026-11-15")).status).toBe(403);
      expect((await call("tech1", partsRoute.POST, "POST", "/api/parts", { sku: "TST-RTE-TECH", name: "x" })).status).toBe(403);
      expect((await call("tech1", partsRoute.GET, "GET", "/api/parts?q=route")).status).toBe(200);
    });
  });

  describe("admin routes", () => {
    it("gets counts and the user directory, and nothing from the job side", async () => {
      const stats = await call("admin", statsRoute.GET, "GET", "/api/admin/stats");
      expect(stats.status).toBe(200);
      expect(Object.keys(stats.json).sort()).toEqual(["ai", "generatedAt", "jobsByStatus", "syncOutcomes", "usersByRole"]);
      const users = await call("admin", usersRoute.GET, "GET", `/api/admin/users?q=${P}`);
      expect(users.status).toBe(200);
      expect(users.json.users.length).toBeGreaterThanOrEqual(5);
      for (const [name, p] of [
        ["jobs", call("admin", jobsRoute.GET, "GET", "/api/jobs")],
        ["customers", call("admin", customersRoute.GET, "GET", "/api/customers")],
        ["parts", call("admin", partsRoute.GET, "GET", "/api/parts")],
        ["board", call("admin", boardRoute.GET, "GET", "/api/board?date=2026-11-15")],
      ] as const) expect((await p).status, name).toBe(403);
      expect((await call("disp", usersRoute.GET, "GET", "/api/admin/users")).status).toBe(403);
    });
  });
});
