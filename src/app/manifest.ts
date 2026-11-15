import type { MetadataRoute } from "next";
import { APP_TITLE } from "@/lib/app-config";

/**
 * The installable technician app: it opens at /tech and stays inside that scope (the service worker's scope too), so
 * dispatcher and admin pages are never part of the installed app.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: APP_TITLE,
    short_name: "Dispatch",
    description: "Your jobs, notes and check-ins, even with no signal.",
    id: "/tech",
    start_url: "/tech",
    scope: "/tech",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f5f6f8",
    theme_color: "#005fb1",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
