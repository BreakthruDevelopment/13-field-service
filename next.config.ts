import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // One self-contained server bundle, so the same Docker image runs on every cloud.
  output: "standalone",
  // Cache Components stays off in the template: most apps here read the session on
  // nearly every page, and the classic dynamic model keeps that simple. An app can
  // opt in later if it has mostly public, cacheable pages.
  cacheComponents: false,
  // Keep the Postgres driver out of the bundle; it is loaded at runtime.
  serverExternalPackages: ["postgres"],
  async headers() {
    const geolocation = [{ key: "Permissions-Policy", value: "geolocation=(self)" }];
    return [
      { source: "/", headers: geolocation },
      { source: "/:path*", headers: geolocation },
      {
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'" },
        ],
      },
    ];
  },
  async rewrites() {
    return [{ source: "/sw.js", destination: "/api/sw" }];
  },
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
