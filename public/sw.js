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
 * Tested in test/sw.test.ts with a fake worker scope; keep this file dependency free and ES5-friendly.
 */
(function (scope) {
  "use strict";

  var BUILD = new URL(scope.location.href).searchParams.get("v") || "dev";
  var STATIC = "fsd-static-" + BUILD;
  var SHELL = "fsd-shell-" + BUILD;
  var SHELL_URL = "/tech";

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
    if (event.data && event.data.type === "wipe") event.waitUntil(deleteAllCaches());
  });

  function isStaticAsset(url) {
    return url.pathname.indexOf("/_next/static/") === 0 || url.pathname.indexOf("/icons/") === 0 || url.pathname === "/manifest.webmanifest";
  }

  function cacheable(res) {
    return res && res.status === 200 && res.type === "basic";
  }

  function staticFirst(request) {
    return scope.caches.open(STATIC).then(function (cache) {
      return cache.match(request).then(function (hit) {
        if (hit) return hit;
        return scope.fetch(request).then(function (res) {
          if (cacheable(res)) cache.put(request, res.clone());
          return res;
        });
      });
    });
  }

  function shell(request) {
    return scope.fetch(request).then(
      function (res) {
        // A redirect (to /sign-in, or /waiting for a role that lost access) is never cached, and it means this device
        // can't be showing a technician's shell any more: drop everything.
        if (res.redirected || res.type === "opaqueredirect" || res.status === 0 || (res.status >= 300 && res.status < 400)) {
          return deleteAllCaches().then(function () { return res; });
        }
        if (res.status === 401 || res.status === 403) {
          return deleteAllCaches().then(function () { return res; });
        }
        if (cacheable(res) && /text\/html/.test(res.headers.get("content-type") || "")) {
          var copy = res.clone();
          scope.caches.open(SHELL).then(function (cache) { return cache.put(SHELL_URL, copy); });
        }
        return res;
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
