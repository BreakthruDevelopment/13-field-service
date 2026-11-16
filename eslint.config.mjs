import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Location is tap-only (decision D6, spec "Geolocation"): no background tracking anywhere, and one fix per tap through the
  // helper in src/lib/offline/geolocation.ts, which is the only file allowed to call getCurrentPosition.
  {
    rules: {
      "no-restricted-properties": [
        "error",
        { property: "watchPosition", message: "Background location tracking is banned. Use captureCheckInLocation() from the Check in at site tap." },
        { property: "getCurrentPosition", message: "Ask for a location only through captureCheckInLocation() in src/lib/offline/geolocation.ts." },
      ],
    },
  },
  { files: ["src/lib/offline/geolocation.ts", "src/lib/offline/*.test.ts"], rules: { "no-restricted-properties": ["error", { property: "watchPosition", message: "Background location tracking is banned." }] } },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "public/sw.js",
  ]),
]);

export default eslintConfig;
