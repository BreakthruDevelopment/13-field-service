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
      match: async (r: Request | string, opts?: { cacheName?: string }) => {
        for (const [name, cache] of stores) if (!opts?.cacheName || opts.cacheName === name) { const hit = await cache.match(r); if (hit) return hit; }
        return undefined;
      },
      keys: async () => [...stores.keys()],
      delete: async (n: string) => stores.delete(n),
    },
    fetch: async (input: Request | string, init?: { signal?: AbortSignal }) => {
      const req = typeof input === "string" ? new Request(input) : input;
      fetched.push(new URL(req.url).pathname);
      const signal = init?.signal ?? (typeof input === "string" ? undefined : input.signal);
      const aborted = new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      const res = await Promise.race([Promise.resolve(network(req)), aborted]);
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
    expect(messages).toEqual([{ type: "warmed", shell: true, assets: 2, missing: 0, ready: true }]);
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
    expect(await down.warm([])).toEqual([{ type: "warmed", shell: false, assets: 0, missing: 0, ready: false }]);
    const out = worker("b1", (req) => (new URL(req.url).pathname === "/tech" ? new Response(null, { status: 307 }) : new Response("chunk")));
    expect(await out.warm([`${ORIGIN}/_next/static/a.js`])).toEqual([{ type: "warmed", shell: false, assets: 1, missing: 0, ready: false }]);
    expect(allCachedPaths(out).filter((p) => p === "/tech")).toEqual([]);
  });

  it("is not ready while a file is missing (the connection dropped half way), and a later warm-up completes it", async () => {
    let up = true;
    const w = worker("b1", (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/tech") return html();
      if (!up && path.endsWith("b.js")) throw new TypeError("offline");
      if (path.endsWith("c.js")) return new Response("gone", { status: 404 });
      return new Response("chunk");
    });
    const urls = [`${ORIGIN}/_next/static/a.js`, `${ORIGIN}/_next/static/b.js`];
    up = false;
    expect(await w.warm(urls)).toEqual([{ type: "warmed", shell: true, assets: 2, missing: 1, ready: false }]);
    expect(allCachedPaths(w).sort()).toEqual(["/_next/static/a.js", "/tech"]);
    up = true;
    expect(await w.warm(urls)).toEqual([{ type: "warmed", shell: true, assets: 2, missing: 0, ready: true }]);
    expect(w.fetched.filter((p) => p === "/tech")).toHaveLength(1); // the shell wasn't fetched again
    expect(w.fetched.filter((p) => p.endsWith("a.js"))).toHaveLength(1);
    // A file the server answers 404 for never becomes ready.
    expect(await w.warm([...urls, `${ORIGIN}/_next/static/c.js`])).toEqual([{ type: "warmed", shell: true, assets: 3, missing: 1, ready: false }]);
  });

  it("copes with garbage input and caps the list", async () => {
    const w = worker("b1", network);
    expect(await w.warm("nope")).toEqual([{ type: "warmed", shell: true, assets: 0, missing: 0, ready: true }]);
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

describe("a wipe during in-flight work", () => {
  const gate = () => {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => (open = resolve));
    return { promise, open };
  };
  const settle = () => new Promise((r) => setTimeout(r, 300));

  it("a warm-up whose /tech fetch is still pending when the device is wiped writes nothing and creates no cache", async () => {
    const g = gate();
    const w = worker("b1", async (req) => {
      if (new URL(req.url).pathname === "/tech") await g.promise;
      return new URL(req.url).pathname === "/tech" ? html() : new Response("chunk");
    });
    const warming = w.warm([`${ORIGIN}/_next/static/chunks/a.js`]);
    await new Promise((r) => setTimeout(r, 20));
    await w.lifecycle("message", { type: "wipe" });
    g.open(); // the response arrives after the wipe (a real fetch would have been aborted; a late one must still write nothing)
    const messages = (await warming) as unknown[];
    await settle();
    expect([...w.stores.keys()]).toEqual([]);
    expect(messages).toEqual([{ type: "warmed", shell: false, assets: 1, missing: 1, ready: false }]);
  });

  it("a wipe aborts the fetches of a warm-up in flight and the later files are never requested", async () => {
    const g = gate();
    const w = worker("b1", async (req) => {
      if (new URL(req.url).pathname === "/_next/static/chunks/a.js") await g.promise;
      return new URL(req.url).pathname === "/tech" ? html() : new Response("chunk");
    });
    const warming = w.warm([`${ORIGIN}/_next/static/chunks/a.js`, `${ORIGIN}/_next/static/chunks/b.js`]);
    await new Promise((r) => setTimeout(r, 400)); // the shell is saved, a.js is pending
    expect(allCachedPaths(w)).toEqual(["/tech"]);
    await w.lifecycle("message", { type: "wipe" });
    await warming; // settles because the pending fetch was aborted, without g.open()
    await settle();
    expect([...w.stores.keys()]).toEqual([]);
    expect(w.fetched).not.toContain("/_next/static/chunks/b.js");
  });

  it("a page's own /_next/static fetch that finishes after a wipe is answered but not cached", async () => {
    const g = gate();
    const w = worker("b1", async () => {
      await g.promise;
      return new Response("chunk");
    });
    const answer = w.ask(new Request(`${ORIGIN}/_next/static/a.js`));
    await new Promise((r) => setTimeout(r, 20));
    await w.lifecycle("message", { type: "wipe" });
    g.open();
    expect(await (await answer)!.text()).toBe("chunk");
    await settle();
    expect([...w.stores.keys()]).toEqual([]);
  });

  it("a shell navigation that finishes after a wipe is answered but not cached", async () => {
    const g = gate();
    const w = worker("b1", async () => {
      await g.promise;
      return html();
    });
    const answer = w.ask(w.nav("/tech"));
    await new Promise((r) => setTimeout(r, 20));
    await w.lifecycle("message", { type: "wipe" });
    g.open();
    expect(await (await answer)!.text()).toBe("<html>shell</html>");
    await settle();
    expect([...w.stores.keys()]).toEqual([]);
  });
});
