import type { NextConfig } from "next";

// A new id per build: the service worker URL carries it (`/sw.js?v=<id>`), so a deploy replaces the worker and its caches.
const BUILD_ID = process.env.GIT_SHA || process.env.GITHUB_SHA || String(Date.now());

const nextConfig: NextConfig = {
  env: { NEXT_PUBLIC_BUILD_ID: BUILD_ID },
  async headers() {
    return [
      // Location is only ever asked for by this origin, from the "Check in at site" tap (see src/lib/offline/geolocation.ts).
      { source: "/(.*)", headers: [{ key: "Permissions-Policy", value: "geolocation=(self)" }] },
      {
        // Never cached by the browser or a CDN, so a new worker (or a fix) reaches every phone on its next open.
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'" },
        ],
      },
    ];
  },
  // One self-contained server bundle, so the same Docker image runs on every cloud.
  output: "standalone",
  // Cache Components stays off in the template: most apps here read the session on
  // nearly every page, and the classic dynamic model keeps that simple. An app can
  // opt in later if it has mostly public, cacheable pages.
  cacheComponents: false,
  // Keep the Postgres driver out of the bundle; it is loaded at runtime.
  serverExternalPackages: ["postgres"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
