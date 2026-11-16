import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let effect: (() => void | (() => void)) | null = null;
vi.mock("react", () => ({ useEffect: (fn: () => void | (() => void)) => void (effect = fn) }));
vi.mock("@/lib/offline/browser", () => ({ finishPendingSignOut: async () => undefined }));

class Target {
  private l = new Map<string, Set<(e?: unknown) => void>>();
  addEventListener(t: string, f: (e?: unknown) => void) {
    (this.l.get(t) ?? this.l.set(t, new Set()).get(t)!).add(f);
  }
  removeEventListener(t: string, f: (e?: unknown) => void) {
    this.l.get(t)?.delete(f);
  }
  emit(t: string, e?: unknown) {
    this.l.get(t)?.forEach((f) => f(e));
  }
}
class Worker extends Target {
  state: string;
  sent: unknown[] = [];
  constructor(state: string) {
    super();
    this.state = state;
  }
  postMessage(m: unknown) {
    this.sent.push(m);
  }
  become(state: string) {
    this.state = state;
    this.emit("statechange");
  }
}

describe("ServiceWorkerRegister", () => {
  let container: Target & { ready: Promise<unknown>; register: ReturnType<typeof vi.fn> };
  let dataset: Record<string, string>;
  beforeEach(() => {
    dataset = {};
    effect = null;
    container = Object.assign(new Target(), { ready: Promise.resolve(), register: vi.fn() });
    vi.stubGlobal("navigator", { serviceWorker: container });
    vi.stubGlobal("window", Object.assign(new Target(), { setTimeout, clearTimeout, dispatchEvent: () => true }));
    vi.stubGlobal("CustomEvent", class {});
    vi.stubGlobal("document", { readyState: "complete", documentElement: { dataset } });
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([{ name: "http://x/_next/static/a.js" } as PerformanceEntry]);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const mount = async () => {
    const { ServiceWorkerRegister } = await import("./service-worker-register");
    ServiceWorkerRegister();
    return effect!() as () => void;
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("after a deploy it warms the replacement worker once it is active, not the old one that `ready` resolved with", async () => {
    const old = new Worker("activated");
    const next = new Worker("installing");
    const registration = { installing: next, waiting: null, active: old };
    container.ready = Promise.resolve(registration);
    container.register.mockResolvedValue(registration);
    const cleanup = await mount();
    await flush();
    expect(old.sent).toEqual([]);
    expect(next.sent).toEqual([]);
    next.become("activated");
    await flush();
    expect(next.sent).toEqual([{ type: "warm", urls: ["http://x/_next/static/a.js"] }]);
    expect(old.sent).toEqual([]);
    cleanup();
  });

  it("while a sign-out is pending it does not warm the caches", async () => {
    const active = new Worker("activated");
    const registration = { installing: null, waiting: null, active };
    container.ready = Promise.resolve(registration);
    container.register.mockResolvedValue(registration);
    (window as unknown as { localStorage: unknown }).localStorage = { getItem: (k: string) => (k === "fsd.pending-signout" ? "1" : null) };
    const cleanup = await mount();
    await flush();
    expect(active.sent).toEqual([]);
    cleanup();
  });

  it("a controller change invalidates readiness and warms again", async () => {
    const active = new Worker("activated");
    const registration = { installing: null, waiting: null, active };
    container.ready = Promise.resolve(registration);
    container.register.mockResolvedValue(registration);
    const cleanup = await mount();
    await flush();
    container.emit("message", { data: { type: "warmed", ready: true } });
    expect(dataset.offlineReady).toBe("1");
    container.emit("controllerchange");
    expect(dataset.offlineReady).toBe("0");
    await flush();
    expect(active.sent).toHaveLength(2);
    cleanup();
  });
});
