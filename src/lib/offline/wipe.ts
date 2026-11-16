import { type KeyValueStorage, REGISTRY_KEY, countUnsynced } from "./store";
import { deleteDb, listAppDatabases } from "./idb";

/**
 * Device hygiene: what "sign out" and "someone else signed in" do to the data on the phone.
 *
 * `wipeLocalData` deletes every `fsd-*` IndexedDB database, every Cache Storage cache and the app's localStorage keys, and
 * tells the service worker to drop its caches (a belt for the cache deletion; the SW also deletes them on a redirect to
 * sign-in). `signOutAndWipe` is what the Sign out button runs: warn if work is unsynced, wipe at once (it works offline),
 * then sign out on the server and call `POST /api/session/clear` (`Clear-Site-Data`, a backstop). Signed out while offline,
 * the wipe is done and the server sign-out waits in a flag until the app next opens online (`finishPendingSignOut`).
 */

export const PENDING_SIGNOUT_KEY = "fsd.pending-signout";

/** True while a sign-out is unfinished on this device: nothing may open the offline database or warm caches meanwhile. */
export function isSignOutPending(storage: Pick<KeyValueStorage, "getItem"> | undefined): boolean {
  try {
    return storage?.getItem(PENDING_SIGNOUT_KEY) === "1";
  } catch {
    return false;
  }
}

export type CachesLike = { keys(): Promise<string[]>; delete(name: string): Promise<boolean> };
export type WorkerLike = { postMessage(message: unknown): void };
export type ServiceWorkerContainerLike = {
  controller?: WorkerLike | null;
  getRegistrations?: () => Promise<readonly { active?: WorkerLike | null }[]>;
};

export type WipeEnv = {
  indexedDB: IDBFactory;
  caches?: CachesLike;
  localStorage?: KeyValueStorage;
  serviceWorker?: ServiceWorkerContainerLike;
  /** Stop every running engine so none writes to a database that is being deleted. */
  haltEngines?: () => void;
  /** Tell this user's other tabs the device was wiped, so they stop and leave (they would otherwise keep the data on screen). */
  announceWipe?: () => void;
};

export type SignOutEnv = WipeEnv & {
  fetch: typeof fetch;
  signOut: () => Promise<{ error?: unknown } | undefined | void>;
  isOnline: () => boolean;
  /** Ask before throwing unsynced work away. Return false to stay signed in. */
  confirmLoss?: (unsynced: number) => boolean | Promise<boolean>;
};

export async function wipeLocalData(env: WipeEnv): Promise<void> {
  env.haltEngines?.();
  try {
    env.announceWipe?.();
  } catch {
    // best effort: the wipe itself is what counts
  }
  const errors: unknown[] = [];
  const attempt = async (work: () => Promise<unknown> | void) => {
    try {
      await work();
    } catch (err) {
      errors.push(err);
    }
  };

  await attempt(async () => {
    for (const name of await listAppDatabases(env.indexedDB, readRegistry(env.localStorage))) await deleteDb(env.indexedDB, name);
  });
  await attempt(async () => {
    if (!env.caches) return;
    for (const key of await env.caches.keys()) await env.caches.delete(key);
  });
  await attempt(async () => {
    env.localStorage?.removeItem(REGISTRY_KEY);
    const sw = env.serviceWorker;
    sw?.controller?.postMessage({ type: "wipe" });
    for (const reg of (await sw?.getRegistrations?.()) ?? []) reg.active?.postMessage({ type: "wipe" });
  });
  // A wipe that only half worked must not look like success: the caller keeps the pending sign-out flag and says so.
  if (errors.length > 0) throw new Error("Couldn't clear everything on this device");
}

function readRegistry(storage: KeyValueStorage | undefined): string[] {
  try {
    const parsed = JSON.parse(storage?.getItem(REGISTRY_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === "string") : [];
  } catch {
    return [];
  }
}

export type SignOutResult =
  | { status: "signed_out"; unsynced: number }
  | { status: "wiped_offline"; unsynced: number }
  | { status: "cancelled"; unsynced: number };

async function serverSignOut(env: SignOutEnv): Promise<boolean> {
  try {
    const result = await env.signOut();
    if (result && typeof result === "object" && "error" in result && result.error) return false;
    await env.fetch("/api/session/clear", { method: "POST", credentials: "same-origin" }).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

export async function signOutAndWipe(env: SignOutEnv): Promise<SignOutResult> {
  const unsynced = await countUnsynced(env).catch(() => 0);
  if (unsynced > 0 && env.confirmLoss && !(await env.confirmLoss(unsynced))) return { status: "cancelled", unsynced };
  // Set first: if the tab dies half way, the next open online finishes the job.
  env.localStorage?.setItem(PENDING_SIGNOUT_KEY, "1");
  let wiped = true;
  try {
    await wipeLocalData(env);
  } catch {
    wiped = false;
  }
  if (env.isOnline() && (await serverSignOut(env))) {
    // Wipe again: anything that wrote to the device while the server call was in flight goes too.
    try {
      await wipeLocalData(env);
    } catch {
      wiped = false;
    }
    if (wiped) env.localStorage?.removeItem(PENDING_SIGNOUT_KEY);
    return { status: "signed_out", unsynced };
  }
  return { status: "wiped_offline", unsynced };
}

/**
 * On app start: if a sign-out was left unfinished (offline, or interrupted), finish it once online. The order matters:
 * the server sign-out FIRST (while it is in flight nothing may open the database: see `isSignOutPending`), then a wipe
 * after it, and only then the flag is cleared. Returns true when it finished (the caller sends the user to sign-in).
 */
export async function finishPendingSignOut(env: SignOutEnv): Promise<boolean> {
  if (!isSignOutPending(env.localStorage) || !env.isOnline()) return false;
  if (!(await serverSignOut(env))) return false;
  try {
    await wipeLocalData(env);
  } catch {
    return false;
  }
  env.localStorage?.removeItem(PENDING_SIGNOUT_KEY);
  return true;
}
