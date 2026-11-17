/**
 * Run `refresh` every `intervalMs` while the document is visible. Hidden tabs don't poll (the board's 60 s budget).
 * Becoming visible again refreshes once and restarts the interval. Does not refresh on start (the page already did).
 */

export type PollDocument = {
  visibilityState: string;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
};

export type PollEnv<T = unknown> = {
  setInterval: (fn: () => void, ms: number) => T;
  clearInterval: (id: T) => void;
  document: PollDocument;
};

export const BOARD_POLL_MS = 60_000;

export function startVisiblePoll<T>(refresh: () => void, env: PollEnv<T>, intervalMs = BOARD_POLL_MS): () => void {
  let id: T | null = null;
  const stop = () => {
    if (id !== null) env.clearInterval(id);
    id = null;
  };
  const start = () => {
    stop();
    id = env.setInterval(() => {
      if (env.document.visibilityState === "visible") refresh();
    }, intervalMs);
  };
  const onVis = () => {
    if (env.document.visibilityState === "visible") {
      refresh();
      start();
    } else {
      stop();
    }
  };
  if (env.document.visibilityState === "visible") start();
  env.document.addEventListener("visibilitychange", onVis);
  return () => {
    stop();
    env.document.removeEventListener("visibilitychange", onVis);
  };
}
