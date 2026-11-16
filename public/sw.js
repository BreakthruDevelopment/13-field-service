/* Service worker for the technician area (registered with scope "/tech" by src/components/service-worker-register.tsx).
 *
 * What it caches, and nothing else:
 *   - /_next/static/* on first fetch (content-hashed, immutable), plus the icons and the manifest;
 *   - the /tech HTML shell, network first, only a 200 that wasn't redirected. The shell renders no job data.
 * What it never caches: /api/* (job data lives only in IndexedDB, per user), any other HTML, anything not GET or not
 * same-origin. A redirect to sign-in while fetching the shell means the session ended: all caches are deleted.
 * It does not precache a build manifest: that would be ~40 requests on install and trip the API Gateway burst limit.
 * Cache names carry the build id (the `?v=` of this script's URL); `activate` deletes every other `fsd-` cache.
 * `{ type: "wipe" }` from the page (sign out) deletes every cache at once.
 * `{ type: "warm", urls }` from the page (sent once it has loaded, so a first visit works offline without a second online
 *   visit): saves the /tech shell if it isn't saved yet and the /_next/static files the page itself loaded (at most 300,
 *   one every 100 ms, so the API Gateway burst limit is never in play), then answers `{ type: "warmed", shell, assets, missing, ready }` (`ready` only when the shell and every file are saved; the
 *   page asks again later when it isn't).
 * Tested in test/sw.test.ts with a fake worker scope; keep this file dependency free and ES5-friendly.
 */
(function (scope) {
  "use strict";

  var BUILD = new URL(scope.location.href).searchParams.get("v") || "dev";
  var STATIC = "fsd-static-" + BUILD;
  var SHELL = "fsd-shell-" + BUILD;
  var SHELL_URL = "/tech";

  // Wipe generation: every cache writer captures it when it starts and writes nothing once it has changed. A wipe bumps it,
  // aborts the warm-ups in flight and deletes every cache, so a fetch that was pending during the wipe can't put its
  // response (or re-create a cache) afterwards.
  var generation = 0;
  var inflight = [];

  function wipeAll() {
    generation++;
    inflight.splice(0).forEach(function (c) { try { c.abort(); } catch (e) { /* ignore */ } });
    return deleteAllCaches();
  }

  // Open `name` and run `work(cache)` only if no wipe happened since `gen`; a wipe in between removes what was made.
  function writeCache(gen, name, work) {
    if (gen !== generation) return Promise.resolve();
    return scope.caches.open(name).then(function (cache) {
      if (gen !== generation) return scope.caches.delete(name);
      return Promise.resolve(work(cache)).then(function (value) {
        if (gen !== generation) return scope.caches.delete(name).then(function () { return value; });
        return value;
      });
    });
  }

  function deleteAllCaches() {
    return scope.caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { return scope.caches.delete(k); }));
    });
  }

  scope.addEventListener("install", function () {
    scope.skipWaiting();
  });

  scope.addEventListener("activate", function (event) {
    event.waitUntil(
      scope.caches.keys().then(function (keys) {
        return Promise.all(
          keys
            .filter(function (k) { return k.indexOf("fsd-") === 0 && k !== STATIC && k !== SHELL; })
            .map(function (k) { return scope.caches.delete(k); })
        );
      }).then(function () { return scope.clients.claim(); })
    );
  });

  scope.addEventListener("message", function (event) {
    var data = event.data;
    if (!data) return;
    if (data.type === "wipe") event.waitUntil(wipeAll());
    else if (data.type === "warm") event.waitUntil(warm(data.urls, event.source));
  });

  function isStaticAsset(url) {
    return url.pathname.indexOf("/_next/static/") === 0 || url.pathname.indexOf("/icons/") === 0 || url.pathname === "/manifest.webmanifest";
  }

  function cacheable(res) {
    return res && res.status === 200 && res.type === "basic";
  }

  function staticFirst(request) {
    var gen = generation;
    return scope.caches.match(request, { cacheName: STATIC }).then(function (hit) {
      if (hit) return hit;
      return scope.fetch(request).then(function (res) {
        if (cacheable(res)) {
          var copy = res.clone();
          writeCache(gen, STATIC, function (cache) { return cache.put(request, copy); }).catch(function () { /* best effort */ });
        }
        return res;
      });
    });
  }

  // Decide what to do with a /tech response. Returns true when it was saved as the shell.
  function keepShell(res, gen) {
    if (gen === undefined) gen = generation;
    // A redirect (to /sign-in, or /waiting for a role that lost access) is never cached, and it means this device
    // can't be showing a technician's shell any more: drop everything.
    if (res.redirected || res.type === "opaqueredirect" || res.status === 0 || (res.status >= 300 && res.status < 400) || res.status === 401 || res.status === 403) {
      return wipeAll().then(function () { return false; });
    }
    if (cacheable(res) && /text\/html/.test(res.headers.get("content-type") || "")) {
      var copy = res.clone();
      return writeCache(gen, SHELL, function (cache) { return cache.put(SHELL_URL, copy); }).then(function () { return gen === generation; });
    }
    return Promise.resolve(false);
  }

  function shell(request) {
    var gen = generation;
    return scope.fetch(request).then(
      function (res) {
        return keepShell(res, gen).then(function () { return res; });
      },
      function () {
        // Offline: the saved shell, if there is one.
        return scope.caches.open(SHELL).then(function (cache) {
          return cache.match(SHELL_URL).then(function (hit) {
            return hit || new Response("You are offline and this phone has no saved copy yet. Open the app once with a connection.", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
          });
        });
      }
    );
  }

  var wait = function (ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); };

  function warm(urls, source) {
    var wanted = [];
    (Array.isArray(urls) ? urls : []).slice(0, 300).forEach(function (u) {
      try {
        var url = new URL(String(u), scope.location.origin);
        if (url.origin === scope.location.origin && url.pathname.indexOf("/_next/static/") === 0 && wanted.indexOf(url.href) < 0) wanted.push(url.href);
      } catch (e) { /* not a URL */ }
    });
    var gen = generation;
    var abort = typeof AbortController === "function" ? new AbortController() : null;
    if (abort) inflight.push(abort);
    var signal = abort ? abort.signal : undefined;
    return scope.caches.match(SHELL_URL, { cacheName: SHELL })
      .then(function (hit) {
        if (hit) return true;
        return scope.fetch(new Request(scope.location.origin + SHELL_URL, { credentials: "same-origin", headers: { accept: "text/html" }, signal: signal }))
          .then(function (res) { return keepShell(res, gen); })
          .catch(function () { return false; });
      })
      .then(function (shellSaved) {
        var missing = 0;
        var chain = Promise.resolve();
        wanted.forEach(function (href) {
          chain = chain.then(function () {
            if (gen !== generation) { missing++; return; }
            return scope.caches.match(href, { cacheName: STATIC }).then(function (hit) {
              if (hit) return;
              return wait(100)
                .then(function () { return gen === generation ? scope.fetch(href, { signal: signal }) : Promise.reject(new Error("wiped")); })
                .then(function (res) {
                  if (!cacheable(res)) { missing++; return; }
                  var copy = res.clone();
                  return writeCache(gen, STATIC, function (cache) { return cache.put(href, copy); });
                })
                .catch(function () { missing++; });
            });
          });
        });
        return chain.then(function () { return { shell: shellSaved && gen === generation, assets: wanted.length, missing: missing }; });
      })
      .then(function (summary) {
        // Ready only when the shell AND every file the page loaded are saved: a shell without its scripts can't start offline.
        summary.ready = summary.shell && summary.missing === 0 && gen === generation;
        var idx = inflight.indexOf(abort);
        if (idx >= 0) inflight.splice(idx, 1);
        if (source && source.postMessage) source.postMessage({ type: "warmed", shell: summary.shell, assets: summary.assets, missing: summary.missing, ready: summary.ready });
      });
  }

  scope.addEventListener("fetch", function (event) {
    var request = event.request;
    if (request.method !== "GET") return;
    var url = new URL(request.url);
    if (url.origin !== scope.location.origin) return;
    if (url.pathname.indexOf("/api/") === 0) return; // never cached, never touched
    if (isStaticAsset(url)) {
      event.respondWith(staticFirst(request));
      return;
    }
    if (request.mode === "navigate" && url.pathname === SHELL_URL) {
      event.respondWith(shell(request));
    }
  });
})(self);
