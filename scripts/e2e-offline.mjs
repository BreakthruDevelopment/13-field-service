#!/usr/bin/env node
// Scripted browser run of the offline technician flow (13.2), in real Chrome through playwright-core:
//   sign in -> load /tech once (the service worker saves the shell and the page's files) -> go offline -> reload (served from the cache)
//   -> add a note, "En route", "Check in at site" (geolocation) offline -> reload (outbox survives) -> go online
//   -> exactly one successful /api/sync with the three ops -> sign out leaves no fsd-* database, no cache, no registry.
//   Then: a different user signing in on the same device deletes the previous user's database.
//
// It drives the technician's real screens (`/tech` and `/tech?job=…`, 13.6) through their labels and buttons: the note
// box, "En route", "Check in at site", the sync chip, the notes list. There is no test-only screen to drive instead —
// a parallel surface can stay green while the product is broken, so gutting `addNote` or `setStatus` in
// `src/app/tech/tech-job.tsx` must turn this run red. The few `data-testid`s it reads (`sync-chip`, `job-status`,
// `job-notes`) are on the elements the technician actually reads.
//
// Two rules when adding a check here:
//   1. Ask the right witness. Anything about *this device* (the cache, IndexedDB, the outbox, what the screen shows
//      offline) is checked in the browser; anything about *what was saved* is checked with `psql`, by value. The
//      screen is drawn from the phone's own copy, so an upload that mangles a note's words, attributes it to someone
//      else or applies ops out of order looks perfect in the UI. `count(*) = 1` is not a check that the technician's
//      words arrived — compare the stored string to the one that was typed.
//   2. End every wait in `fail` with a sentence. A raw Playwright timeout sends the next person to debug the test.
//
// Needs the app built and running, `psql` and DATABASE_URL to grant roles, and Chrome (CHROME_PATH, default
// /usr/bin/google-chrome):
//   PORT=3137 HOSTNAME=127.0.0.1 node .next/standalone/server.js &
//   BASE_URL=http://localhost:3137 DATABASE_URL=... node scripts/e2e-offline.mjs
import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const DB = process.env.DATABASE_URL;
const CHROME = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";
const RUN = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
if (!DB) throw new Error("DATABASE_URL is required (roles are granted with psql)");

const fail = (msg) => {
  console.error(`E2E FAIL: ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
};
const ok = (msg) => console.log(`ok - ${msg}`);
const psql = (sql) => execFileSync("psql", [DB, "-qtA", "-c", sql], { encoding: "utf8" }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const headers = { origin: new URL(BASE).origin, "content-type": "application/json" };

async function authed(email, name, role) {
  // Better Auth rate-limits sign-ups per IP; wait out a 429 once.
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`${BASE}/api/auth/sign-up/email`, { method: "POST", headers, body: JSON.stringify({ email, password: "e2e-password-12345", name }) });
    if (res.status === 429) {
      await sleep(11_000);
      continue;
    }
    if (!res.ok) fail(`sign-up ${email}: ${res.status}`);
    break;
  }
  const id = psql(`update "user" set role = '${role}' where email = '${email}' returning id`);
  if (!id) fail(`no user ${email}`);
  return id;
}
async function signIn(context, email) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await context.request.post(`${BASE}/api/auth/sign-in/email`, { headers, data: { email, password: "e2e-password-12345" } });
    if (res.status() === 429) {
      await sleep(11_000);
      continue;
    }
    if (!res.ok()) fail(`sign-in ${email}: ${res.status()}`);
    return;
  }
}
async function api(context, method, path, data) {
  const res = await context.request.fetch(`${BASE}${path}`, { method, headers, data });
  return { status: res.status(), json: await res.json().catch(() => ({})) };
}

const EMAILS = { disp: `e2e-disp-${RUN}@example.test`, t1: `e2e-t1-${RUN}@example.test`, t2: `e2e-t2-${RUN}@example.test` };
const dispatcherId = await authed(EMAILS.disp, "E2E Dispatcher", "dispatcher");
const t1Id = await authed(EMAILS.t1, "E2E Tech One", "technician");
const t2Id = await authed(EMAILS.t2, "E2E Tech Two", "technician");

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
try {
  // The dispatcher sets the day up through the API.
  const dctx = await browser.newContext();
  await signIn(dctx, EMAILS.disp);
  const hour = (h) => new Date(Math.ceil((Date.now() + h * 3600_000) / 3600_000) * 3600_000).toISOString();
  const customer = await api(dctx, "POST", "/api/customers", { name: "E2E Co", phone: "555-0100" });
  const site = await api(dctx, "POST", `/api/customers/${customer.json.customer.id}/sites`, { label: "Main", address: "1 E2E St", lat: 30.2672, lng: -97.7431 });
  const created = await api(dctx, "POST", "/api/jobs", { customerId: customer.json.customer.id, siteId: site.json.site.id, title: `E2E sink ${RUN}`, assigneeId: t1Id, scheduledStart: hour(2), scheduledEnd: hour(3) });
  if (created.status !== 201) fail(`create job: ${created.status} ${JSON.stringify(created.json)}`);
  const jobId = created.json.job.id;

  // The technician's phone.
  const context = await browser.newContext({ permissions: ["geolocation"], geolocation: { latitude: 30.26721999, longitude: -97.74309999, accuracy: 20 }, viewport: { width: 375, height: 700 } });
  await signIn(context, EMAILS.t1);
  const page = await context.newPage();
  const syncResponses = [];
  const pageErrors = [];
  page.on("response", (r) => {
    if (r.url().endsWith("/api/sync") && r.request().method() === "POST") syncResponses.push(r);
  });
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  // The real screens, by what the technician sees and taps. Every helper ends in `fail`, never in a raw Playwright
  // timeout: a broken product should read as a sentence, so nobody debugs the test instead of the bug.
  const TITLE = `E2E sink ${RUN}`;
  // The exact words the technician types. The server is asked for this string back, not for a row count.
  const NOTE = `Offline note: replaced the cartridge on job ${RUN}.`;
  const jobCard = () => page.getByRole("link", { name: new RegExp(`E2E sink ${RUN}`) });
  const jobHeading = () => page.getByRole("heading", { name: TITLE });
  const noteBox = () => page.getByLabel("Note", { exact: true });
  const show = async (what, work) => {
    try {
      return await work();
    } catch (err) {
      fail(`${what} (${err?.name === "TimeoutError" ? "it never appeared" : err?.message ?? err})`);
    }
  };
  const see = (locator, what, timeout = 20_000) => show(what, () => locator.waitFor({ timeout }));
  const tap = (name, timeout = 20_000) => show(`tap "${name}"`, () => page.getByRole("button", { name, exact: true }).click({ timeout }));
  // Raw read, for the failure messages below: null rather than a throw when the element isn't there.
  const read = (id) =>
    page
      .getByTestId(id)
      .innerText({ timeout: 10_000 })
      .then((value) => value.trim())
      .catch(() => null);
  const text = async (id) => {
    const value = await read(id);
    if (value === null) fail(`the screen has no "${id}"`);
    return value;
  };
  const waitText = async (id, expected, timeout = 20_000) => {
    try {
      await page.waitForFunction(
        ([i, e]) => document.querySelector(`[data-testid="${i}"]`)?.textContent?.trim() === e,
        [id, expected],
        { timeout },
      );
    } catch {
      fail(`${id} should read "${expected}", the screen shows "${(await read(id)) ?? "<not on the page>"}"`);
    }
  };

  await page.goto(`${BASE}/tech`);
  // My jobs draws the card from the snapshot the phone downloaded, not from the HTML.
  await see(jobCard(), "My jobs should show the technician's job", 30_000);
  ok("online: My jobs shows the technician's job from the snapshot");
  // First visit, no second online navigation: the page hands the worker its file list and the worker saves the shell.
  await page.waitForFunction(() => document.documentElement.dataset.offlineReady === "1", null, { timeout: 30_000 });
  const cached = await page.evaluate(async () => {
    const out = {};
    for (const k of await caches.keys()) out[k] = (await (await caches.open(k)).keys()).map((r) => new URL(r.url).pathname);
    return out;
  });
  const paths = Object.values(cached).flat();
  if (!paths.includes("/tech")) fail(`the /tech shell should be cached: ${JSON.stringify(cached)}`);
  if (paths.some((p) => p.startsWith("/api"))) fail(`no /api response may be cached: ${JSON.stringify(cached)}`);
  if (!paths.some((p) => p.startsWith("/_next/static/"))) fail(`static chunks should be cached: ${JSON.stringify(cached)}`);
  ok("service worker active: the /tech shell and static chunks are cached, nothing from /api");

  // Open the job the way a technician does: tap the card.
  await jobCard().click();
  await see(jobHeading(), "the job page should open");
  await see(noteBox(), "the job page should have a Note box");

  await context.setOffline(true);
  await page.reload();
  await see(jobHeading(), "an offline reload should still show the job page", 30_000);
  if ((await text("job-status")) !== "Scheduled") fail("offline reload should show the saved job as Scheduled");
  ok("offline: reload is served from the cache and shows the saved job");

  await noteBox().fill(NOTE);
  await tap("Add note");
  await tap("En route");
  await waitText("sync-chip", "Offline · 2 changes waiting");
  await tap("Check in at site");
  await waitText("sync-chip", "Offline · 3 changes waiting");
  if ((await text("job-status")) !== "On site") fail("the job page should show On site while offline");
  if (!(await text("job-notes")).includes(NOTE)) fail(`the queued note should read "${NOTE}": ${await text("job-notes")}`);
  if (!(await text("job-notes")).includes("Waiting to sync")) fail("a queued note must say it is waiting to sync");
  await sleep(2500); // the 2 s debounce fires and fails: ops must stay
  if ((await text("sync-chip")) !== "Offline · 3 changes waiting") fail("ops must stay queued while offline");
  await page.reload();
  await see(jobHeading(), "the job page should survive an offline reload", 30_000);
  await waitText("sync-chip", "Offline · 3 changes waiting");
  if ((await text("job-status")) !== "On site") fail("the offline status change should survive a reload");
  if (!(await text("job-notes")).includes(NOTE)) fail("the queued note should survive a reload with its words intact");
  ok("offline: a note, En route and a geolocated check-in queue on the job page and survive a reload");

  const before = syncResponses.length;
  await context.setOffline(false);
  await waitText("sync-chip", "Up to date", 30_000);
  if ((await text("job-notes")).includes("Waiting to sync")) fail("a synced note must stop saying it is waiting");
  await sleep(1500);
  const okSyncs = [];
  for (const r of syncResponses.slice(before)) if (r.status() === 200) okSyncs.push(await r.json());
  if (okSyncs.length !== 1) fail(`expected exactly one successful sync, got ${okSyncs.length}`);
  if (okSyncs[0].results.map((r) => r.outcome).join() !== "applied,applied,applied") fail(`all three ops should apply: ${JSON.stringify(okSyncs[0])}`);
  // Ask the database what it stored, never the screen. The screen is drawn from the phone's own copy, so a sync that
  // uploads the wrong words, the wrong author or the wrong order still looks perfect in the UI.
  const noteRows = psql(`select author_id || ' | ' || body from job_note where job_id = '${jobId}' order by server_at`);
  if (noteRows !== `${t1Id} | ${NOTE}`) fail(`the server should hold exactly the technician's words, once: ${JSON.stringify(noteRows)}`);
  // Which ops landed, and the check-in location, are checked by value: dropping the location on upload (the server
  // takes it as optional) fails this line. The *order* half is belt-and-braces over a server invariant, not something
  // this test can prove: `dependsOn`, `baseStatusVersion` and the transition rules make the server refuse a reordered
  // batch on its own, so no client change can reorder these rows.
  const events = psql(`select string_agg(to_status || coalesce(' @' || lat || ',' || lng, ''), ' -> ' order by server_at) from job_event where job_id = '${jobId}' and actor_id = '${t1Id}' and kind = 'status'`);
  if (events !== "en_route -> on_site @30.2672,-97.7431") fail(`both status ops should land once, in order, with the check-in location on on_site only: ${JSON.stringify(events)}`);
  const status = psql(`select status from service_job where id = '${jobId}'`);
  if (status !== "on_site") fail(`the job should be on_site on the server, it is ${status}`);
  ok("back online: one sync request stored the technician's exact words, En route and the check-in (4-decimal location) exactly once");

  // Sign out through the real button.
  page.on("dialog", (d) => d.accept());
  await tap("Sign out");
  await page.waitForURL("**/sign-in", { timeout: 20_000 });
  const left = await page.evaluate(async () => ({
    dbs: (await indexedDB.databases()).map((d) => d.name).filter((n) => n?.startsWith("fsd-")),
    caches: await caches.keys(),
    registry: localStorage.getItem("fsd.dbs"),
    pending: localStorage.getItem("fsd.pending-signout"),
  }));
  if (left.dbs.length || left.caches.length || left.registry || left.pending) fail(`sign-out should leave nothing: ${JSON.stringify(left)}`);
  const afterSignOut = await page.goto(`${BASE}/tech`);
  if (!page.url().includes("/sign-in")) fail(`signed-out /tech should go to sign-in, got ${page.url()} (${afterSignOut?.status()})`);
  ok("sign out: no fsd-* database, no cache, no registry left; /tech sends the signed-out phone to sign-in");

  // A different user on the same device: the previous user's database is deleted before anything renders.
  await signIn(context, EMAILS.t1);
  await page.goto(`${BASE}/tech?job=${encodeURIComponent(jobId)}`);
  await see(noteBox(), "technician 1 should get their job page back after signing in again", 30_000);
  await noteBox().fill("left on the phone");
  await tap("Add note").catch(() => undefined);
  const mine = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
  if (!mine.some((n) => n?.startsWith("fsd-"))) fail(`technician 1 should have a database: ${mine}`);
  await context.clearCookies(); // the session ended without a sign-out, and someone else signs in
  await signIn(context, EMAILS.t2);
  await page.goto(`${BASE}/tech`);
  // Technician 2 has no jobs: My jobs says so once the phone has been read.
  await see(page.getByText("No jobs on this phone yet"), "technician 2 should be told this phone holds no jobs of theirs", 30_000);
  // The server before the device check below, so a foreign-authored row fails here too and not only there — on a
  // broken cross-user wipe the device check is the right one to fire, but a row written as the wrong technician needs
  // a server-side failure of its own. The query is not a no-op: planting one foreign note and event turns this 0/0
  // into 1/1. Nothing of technician 1's may reach the job under technician 2's name.
  const foreign = psql(`select count(*) from job_note where job_id = '${jobId}' and author_id <> '${t1Id}'`);
  const foreignEvents = psql(`select count(*) from job_event where job_id = '${jobId}' and actor_id = '${t2Id}'`);
  if (foreign !== "0" || foreignEvents !== "0") fail(`technician 2 must not have written to technician 1's job: notes=${foreign} events=${foreignEvents}`);
  const dbs = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name).filter((n) => n?.startsWith("fsd-")));
  if (dbs.length !== 1 || !dbs[0].includes(encodeURIComponent(t2Id))) fail(`only technician 2's database should remain: ${dbs}`);
  ok("another technician on the same phone: the previous user's database is gone, only their own remains, and nothing was written to the job as them");

  // An unfinished sign-out: the server call is slow and /api/session/clear is blocked. While the flag is set, a second tab
  // must not open IndexedDB, download the snapshot or warm caches; when the server sign-out is done, the device is wiped again.
  await context.route("**/api/auth/sign-out", async (route) => {
    await sleep(4_000);
    await route.continue();
  });
  await context.route("**/api/session/clear", (route) => route.abort());
  const snapshotFetches = [];
  context.on("request", (req) => {
    if (req.url().includes("/api/my/jobs")) snapshotFetches.push(Date.now());
  });
  await tap("Sign out");
  await page.waitForFunction(() => localStorage.getItem("fsd.pending-signout") === "1", null, { timeout: 5_000 });
  const second = await context.newPage();
  const fetchesBefore = snapshotFetches.length;
  await second.goto(`${BASE}/tech`);
  await sleep(2_000);
  const during = await second.evaluate(async () => ({
    dbs: (await indexedDB.databases()).map((d) => d.name).filter((n) => n?.startsWith("fsd-")),
    ready: document.documentElement.dataset.offlineReady ?? null,
    pending: localStorage.getItem("fsd.pending-signout"),
    url: location.pathname,
  }));
  if (during.url === "/tech" && during.pending === "1") {
    if (during.dbs.length || during.ready === "1") fail(`while a sign-out is pending nothing may be opened or warmed: ${JSON.stringify(during)}`);
    if (snapshotFetches.length !== fetchesBefore) fail("while a sign-out is pending no snapshot may be downloaded");
  }
  await page.waitForURL("**/sign-in", { timeout: 20_000 });
  await sleep(1_500);
  for (const p of [page, second]) {
    const after = await p.evaluate(async () => ({
      dbs: (await indexedDB.databases()).map((d) => d.name).filter((n) => n?.startsWith("fsd-")),
      // A tab that was still loading may re-cache public static files after the wipe; the shell and anything else may not stay.
      caches: (await Promise.all((await caches.keys()).map(async (k) => (await (await caches.open(k)).keys()).map((r) => new URL(r.url).pathname)))).flat().filter((p) => !p.startsWith("/_next/static/")),
      pending: localStorage.getItem("fsd.pending-signout"),
    }));
    if (after.dbs.length || after.caches.length) fail(`a slow sign-out must still end with a wiped device: ${JSON.stringify(after)}`);
  }
  ok("unfinished sign-out: a second tab opens no database, downloads no snapshot and warms no cache; the device ends wiped");
  await second.close();

  if (pageErrors.length) fail(`the technician screens threw: ${pageErrors.join(" | ")}`);
  console.log("E2E PASS");
} finally {
  await browser.close();
  void dispatcherId;
}
