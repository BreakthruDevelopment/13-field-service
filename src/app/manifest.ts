import type { MetadataRoute } from "next";
import { APP_DESCRIPTION, APP_TITLE } from "@/lib/app-config";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: APP_TITLE,
    short_name: "Field Service",
    description: APP_DESCRIPTION,
    start_url: "/tech",
    scope: "/",
    display: "standalone",
    background_color: "#f5f6f8",
    theme_color: "#005fb1",
    icons: [{ src: "/icon.png", sizes: "512x512", type: "image/png", purpose: "any" }],
  };
}
