/**
 * public/sw.js in a fake worker scope: what it caches (the app shell and static assets), what it never caches (/api/*,
 * other pages, redirects), the offline fallback, old-build cleanup and the sign-out wipe message.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const SOURCE = readFileSync(path.resolve(__dirname, "../public/sw.js"), "utf8");
const ORIGIN = "https://app13.example";

class FakeCache {
  entries = new Map<string, Response>();
  key = (r: Request | string) => new URL(typeof r === "string" ? r : r.url, ORIGIN).pathname + (typeof r === "string" ? "" : new URL(r.url).search);
  async match(r: Request | string) {
    return this.entries.get(this.key(r))?.clone();
  }
  async put(r: Request | string, res: Response) {
    this.entries.set(this.key(r), res);
  }
}

function worker(build = "b1", network: (req: Request) => Promise<Response> | Response = () => new Response("ok")) {
  const stores = new Map<string, FakeCache>();
  const listeners: Record<string, ((e: any) => void)[]> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
  const fetched: string[] = [];
  const scope = {
    location: new URL(`${ORIGIN}/sw.js?v=${build}`),
    caches: {
      open: async (n: string) => stores.get(n) ?? stores.set(n, new FakeCache()).get(n)!,
      keys: async () => [...stores.keys()],
      delete: async (n: string) => stores.delete(n),
    },
    fetch: async (input: Request | string) => {
      const req = typeof input === "string" ? new Request(input) : input;
      fetched.push(new URL(req.url).pathname);
      const res = await network(req);
      // A real same-origin network response has type "basic"; a hand-made Response has "default".
      if (res.type === "default") Object.defineProperty(res, "type", { value: "basic" });
      return res;
    },
    clients: { claim: async () => undefined },
    skipWaiting: () => undefined,
    addEventListener: (type: string, fn: (e: unknown) => void) => void (listeners[type] ??= []).push(fn),
  };
  new Function("self", SOURCE.replace(/\}\)\(self\);\s*$/, "})(self);"))(scope);
  const ask = async (req: Request) => {
    let response: Promise<Response> | undefined;
    for (const fn of listeners.fetch) fn({ request: req, respondWith: (p: Promise<Response>) => (response = Promise.resolve(p)) });
    return response; // undefined: the worker stood aside and the browser uses the network
  };
  const lifecycle = async (type: string, data?: unknown) => {
    const waits: Promise<unknown>[] = [];
    for (const fn of listeners[type] ?? []) fn({ data, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
  };
  const warm = async (urls: unknown) => {
    const messages: unknown[] = [];
    const waits: Promise<unknown>[] = [];
    for (const fn of listeners.message ?? []) fn({ data: { type: "warm", urls }, source: { postMessage: (m: unknown) => messages.push(m) }, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
    return messages;
  };
  const nav = (p: string) => Object.defineProperty(new Request(`${ORIGIN}${p}`), "mode", { value: "navigate" });
  return { stores, fetched, ask, lifecycle, warm, nav, scope };
}

const html = (body = "<html>shell</html>") => new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
const allCachedPaths = (w: ReturnType<typeof worker>) => [...w.stores.values()].flatMap((c) => [...c.entries.keys()]);

describe("service worker", () => {
  it("caches /_next/static on first fetch and serves it from the cache after", async () => {
    const w = worker("b1", () => new Response("chunk", { status: 200 }));
    const url = `${ORIGIN}/_next/static/chunks/a.js`;
    expect(await (await w.ask(new Request(url)))!.text()).toBe("chunk");
    expect(await (await w.ask(new Request(url)))!.text()).toBe("chunk");
    expect(w.fetched).toEqual(["/_next/static/chunks/a.js"]);
    expect(allCachedPaths(w)).toEqual(["/_next/static/chunks/a.js"]);
  });

  it("never touches /api/*, other methods, other origins or other pages", async () => {
    const w = worker();
    expect(await w.ask(new Request(`${ORIGIN}/api/my/jobs`))).toBeUndefined();
    expect(await w.ask(new Request(`${ORIGIN}/api/sync`, { method: "POST", body: "{}" }))).toBeUndefined();
    expect(await w.ask(new Request("https://elsewhere.example/_next/static/x.js"))).toBeUndefined();
    expect(await w.ask(w.nav("/board"))).toBeUndefined();
    expect(await w.ask(w.nav("/jobs/123"))).toBeUndefined();
    expect(await w.ask(w.nav("/tech/other"))).toBeUndefined();
    expect(await w.ask(new Request(`${ORIGIN}/tech?_rsc=abc`, { headers: { rsc: "1" } }))).toBeUndefined(); // not a navigation
    expect(w.fetched).toEqual([]);
    expect(allCachedPaths(w)).toEqual([]);
  });

  it("caches the /tech shell network first (query ignored), and serves it when the network is gone", async () => {
    let online = true;
    const w = worker("b1", () => {
      if (!online) throw new TypeError("offline");
      return html("<html>v1</html>");
    });
    expect(await (await w.ask(w.nav("/tech?job=abc")))!.text()).toBe("<html>v1</html>");
    expect(allCachedPaths(w)).toEqual(["/tech"]);
    online = false;
    expect(await (await w.ask(w.nav("/tech?job=other")))!.text()).toBe("<html>v1</html>");
  });

  it("offline with nothing saved answers a plain 503", async () => {
    const w = worker("b1", () => {
      throw new TypeError("offline");
    });
    const res = (await w.ask(w.nav("/tech")))!;
    expect(res.status).toBe(503);
  });

  it("doesn't cache a non-HTML or non-200 shell response, and a redirect (the session ended) deletes every cache", async () => {
    let next: Response = new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    const w = worker("b1", () => next);
    await w.ask(w.nav("/tech"));
    expect(allCachedPaths(w)).toEqual([]);
    next = html();
    await w.ask(w.nav("/tech"));
    await w.ask(new Request(`${ORIGIN}/_next/static/c.js`));
    expect(allCachedPaths(w).sort()).toEqual(["/_next/static/c.js", "/tech"]);
    const redirected = html("<html>sign in</html>");
    Object.defineProperty(redirected, "redirected", { value: true });
    next = redirected;
    await w.ask(w.nav("/tech"));
    expect(allCachedPaths(w)).toEqual([]);
  });

  it("an opaque redirect or a 401/403 also deletes every cache and is never stored", async () => {
    for (const res of [new Response(null, { status: 307 }), new Response("no", { status: 401 }), new Response("no", { status: 403 })]) {
      const w = worker("b1", () => html());
      await w.ask(w.nav("/tech"));
      expect(allCachedPaths(w)).toEqual(["/tech"]);
      const cached = w.stores.get("fsd-shell-b1")!;
      expect(cached).toBeDefined();
      const w2 = worker("b1", () => res);
      await w2.stores.set("fsd-shell-b1", cached);
      await w2.ask(w2.nav("/tech"));
      expect(allCachedPaths(w2)).toEqual([]);
    }
  });

  it("cache names carry the build id, and activate deletes every other fsd- cache and leaves foreign ones alone", async () => {
    const w = worker("b2");
    for (const n of ["fsd-static-b1", "fsd-shell-b1", "fsd-static-b2", "fsd-shell-b2", "unrelated"]) w.stores.set(n, new FakeCache());
    await w.lifecycle("activate");
    expect([...w.stores.keys()].sort()).toEqual(["fsd-shell-b2", "fsd-static-b2", "unrelated"]);
  });

  it("a wipe message from the page deletes every cache", async () => {
    const w = worker();
    await w.ask(new Request(`${ORIGIN}/_next/static/a.js`));
    await w.ask(w.nav("/tech"));
    expect(allCachedPaths(w).length).toBeGreaterThan(0);
    await w.lifecycle("message", { type: "wipe" });
    expect([...w.stores.keys()]).toEqual([]);
    await w.lifecycle("message", { type: "something-else" });
  });

  it("after a mixed session nothing from /api is in any cache", async () => {
    const w = worker("b1", (req) => (new URL(req.url).pathname === "/tech" ? html() : new Response("x")));
    for (const p of ["/api/my/jobs", "/api/sync", "/api/jobs", "/_next/static/a.js", "/icons/icon-192.png"]) await w.ask(new Request(`${ORIGIN}${p}`));
    await w.ask(w.nav("/tech"));
    expect(allCachedPaths(w).filter((p) => p.startsWith("/api"))).toEqual([]);
    expect(allCachedPaths(w).sort()).toEqual(["/_next/static/a.js", "/icons/icon-192.png", "/tech"]);
  });
});

describe("service worker warm-up (first visit, no second online navigation)", () => {
  const network = (req: Request) => (new URL(req.url).pathname === "/tech" ? html() : new Response("chunk"));

  it("saves the shell and the files the page loaded, then reports it", async () => {
    const w = worker("b1", network);
    const messages = await w.warm([`${ORIGIN}/_next/static/chunks/a.js`, `${ORIGIN}/_next/static/css/b.css`]);
    expect(messages).toEqual([{ type: "warmed", shell: true, assets: 2 }]);
    expect(allCachedPaths(w).sort()).toEqual(["/_next/static/chunks/a.js", "/_next/static/css/b.css", "/tech"]);
    // ...and now an offline navigation works.
    const offline = worker("b1", () => { throw new TypeError("offline"); });
    for (const [name, cache] of w.stores) offline.stores.set(name, cache);
    expect(await (await offline.ask(offline.nav("/tech")))!.text()).toBe("<html>shell</html>");
  });

  it("ignores anything that isn't this origin's /_next/static, fetches each file once, and skips what is already saved", async () => {
    const w = worker("b1", network);
    await w.warm([`${ORIGIN}/_next/static/a.js`, `${ORIGIN}/_next/static/a.js`, `${ORIGIN}/api/my/jobs`, "https://evil.example/_next/static/x.js", "not a url", 42, `${ORIGIN}/board`]);
    expect(w.fetched.sort()).toEqual(["/_next/static/a.js", "/tech"]);
    const before = w.fetched.length;
    await w.warm([`${ORIGIN}/_next/static/a.js`]);
    expect(w.fetched.length).toBe(before); // shell and chunk already saved
    expect(allCachedPaths(w).filter((p) => p.startsWith("/api"))).toEqual([]);
  });

  it("reports shell: false when it can't be saved (offline, signed out) and caches nothing from a redirect", async () => {
    const down = worker("b1", () => { throw new TypeError("offline"); });
    expect(await down.warm([])).toEqual([{ type: "warmed", shell: false, assets: 0 }]);
    const out = worker("b1", (req) => (new URL(req.url).pathname === "/tech" ? new Response(null, { status: 307 }) : new Response("chunk")));
    expect(await out.warm([`${ORIGIN}/_next/static/a.js`])).toEqual([{ type: "warmed", shell: false, assets: 1 }]);
    expect(allCachedPaths(out).filter((p) => p === "/tech")).toEqual([]);
  });

  it("copes with garbage input and caps the list", async () => {
    const w = worker("b1", network);
    expect(await w.warm("nope")).toEqual([{ type: "warmed", shell: true, assets: 0 }]);
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => {
      fn();
      return 0;
    }) as never);
    const many = Array.from({ length: 400 }, (_, i) => `${ORIGIN}/_next/static/c${i}.js`);
    const [msg] = (await w.warm(many)) as { assets: number }[];
    spy.mockRestore();
    expect(msg.assets).toBe(300);
  });
});
