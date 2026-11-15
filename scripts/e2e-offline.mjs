#!/usr/bin/env node
// Scripted browser run of the offline technician flow (13.2), in real Chrome through playwright-core:
//   sign in -> load /tech (service worker installs, shell + chunks cached) -> go offline -> reload (served from the cache)
//   -> add a note, "En route", "Check in at site" (geolocation) offline -> reload (outbox survives) -> go online
//   -> exactly one successful /api/sync with the three ops -> sign out leaves no fsd-* database, no cache, no registry.
//   Then: a different user signing in on the same device deletes the previous user's database.
//
// Needs the app built and running with E2E_OFFLINE=1 (it adds a bare test screen to /tech), `psql` and DATABASE_URL to
// grant roles, and Chrome (CHROME_PATH, default /usr/bin/google-chrome):
//   E2E_OFFLINE=1 PORT=3137 HOSTNAME=127.0.0.1 node .next/standalone/server.js &
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
  page.on("response", (r) => {
    if (r.url().endsWith("/api/sync") && r.request().method() === "POST") syncResponses.push(r);
  });
  const text = (id) => page.getByTestId(id).innerText();
  const waitText = (id, expected, timeout = 20_000) => page.waitForFunction(([i, e]) => document.querySelector(`[data-testid="${i}"]`)?.textContent === e, [id, expected], { timeout });

  await page.goto(`${BASE}/tech`);
  await waitText("ready", "ready");
  await page.getByTestId("job-title").waitFor();
  ok("online: the harness shows the technician's job from the snapshot");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); // now controlled by the worker: static chunks and the shell are cached as they load
  await waitText("ready", "ready");
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

  await context.setOffline(true);
  await page.reload();
  await waitText("ready", "ready");
  if ((await text("job-title")) !== `E2E sink ${RUN}`) fail("offline reload should show the saved job");
  ok("offline: reload is served from the cache and shows the saved job");

  await page.getByLabel("note").fill("Offline note: replaced the cartridge.");
  await page.getByRole("button", { name: "Add note" }).click();
  await page.getByRole("button", { name: "En route" }).click();
  await waitText("pending", "2");
  await page.getByRole("button", { name: "Check in at site" }).click();
  await waitText("pending", "3");
  if ((await text("job-status")) !== "on_site") fail("the screen should show on_site while offline");
  await sleep(2500); // the 2 s debounce fires and fails: ops must stay
  if ((await text("pending")) !== "3") fail("ops must stay queued while offline");
  await page.reload();
  await waitText("ready", "ready");
  await waitText("pending", "3");
  if (!(await text("job-notes")).includes("Offline note")) fail("the queued note should survive a reload");
  ok("offline: a note, En route and a geolocated check-in queue and survive a reload");

  const before = syncResponses.length;
  await context.setOffline(false);
  await waitText("pending", "0", 30_000);
  await sleep(1500);
  const okSyncs = [];
  for (const r of syncResponses.slice(before)) if (r.status() === 200) okSyncs.push(await r.json());
  if (okSyncs.length !== 1) fail(`expected exactly one successful sync, got ${okSyncs.length}`);
  if (okSyncs[0].results.map((r) => r.outcome).join() !== "applied,applied,applied") fail(`all three ops should apply: ${JSON.stringify(okSyncs[0])}`);
  const notes = psql(`select count(*) from job_note where job_id = '${jobId}'`);
  const loc = psql(`select lat || ',' || lng from job_event where job_id = '${jobId}' and to_status = 'on_site'`);
  const status = psql(`select status from service_job where id = '${jobId}'`);
  if (notes !== "1" || loc !== "30.2672,-97.7431" || status !== "on_site") fail(`server state wrong: notes=${notes} loc=${loc} status=${status}`);
  ok("back online: one sync request applied the note, En route and the check-in (4-decimal location) exactly once");

  // Sign out through the real button.
  page.on("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Sign out" }).click();
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
  await page.goto(`${BASE}/tech`);
  await waitText("ready", "ready");
  await page.getByLabel("note").fill("left on the phone");
  await page.getByRole("button", { name: "Add note" }).click().catch(() => undefined);
  const mine = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
  if (!mine.some((n) => n?.startsWith("fsd-"))) fail(`technician 1 should have a database: ${mine}`);
  await context.clearCookies(); // the session ended without a sign-out, and someone else signs in
  await signIn(context, EMAILS.t2);
  await page.goto(`${BASE}/tech`);
  await waitText("ready", "ready");
  const dbs = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name).filter((n) => n?.startsWith("fsd-")));
  if (dbs.length !== 1 || !dbs[0].includes(encodeURIComponent(t2Id))) fail(`only technician 2's database should remain: ${dbs}`);
  ok("another technician on the same phone: the previous user's database is gone, only their own remains");

  console.log("E2E PASS");
} finally {
  await browser.close();
  void dispatcherId;
}
