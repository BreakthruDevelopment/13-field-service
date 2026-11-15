import type { TechDataEngine } from "./engine";

export const FLUSH_INTERVAL_MS = 60_000;

type Target = Pick<EventTarget, "addEventListener" | "removeEventListener">;

/**
 * When the engine runs besides "an op was queued" (which the engine schedules itself): the `online` event, the tab
 * becoming visible, and every 60 s while visible with something waiting. Returns the function that removes them.
 */
export function attachTriggers(
  engine: TechDataEngine,
  env: {
    window: Target;
    document: Target & { visibilityState: string };
    setInterval: (fn: () => void, ms: number) => unknown;
    clearInterval: (handle: unknown) => void;
  },
): () => void {
  const wake = () => {
    void engine.flush();
    void engine.refresh();
  };
  const onVisible = () => {
    if (env.document.visibilityState === "visible") wake();
  };
  env.window.addEventListener("online", wake);
  env.document.addEventListener("visibilitychange", onVisible);
  const interval = env.setInterval(() => {
    if (env.document.visibilityState === "visible" && engine.getState().pending > 0) void engine.flush();
  }, FLUSH_INTERVAL_MS);
  return () => {
    env.window.removeEventListener("online", wake);
    env.document.removeEventListener("visibilitychange", onVisible);
    env.clearInterval(interval);
  };
}
