/**
 * Loads the demo workspace (src/lib/demo.ts) into a LOCAL or CI database and gives the demo dispatchers and technicians
 * a password so you can sign in as them. Refuses to run against production (src/lib/demo-seed-config.ts).
 *
 *   DEMO_SEED=yes DEMO_PASSWORD='at-least-10-chars' APP_URL=http://localhost:3000 DATABASE_URL=... pnpm db:seed-demo
 *
 * Demo accounts: fs-dispatcher-1@demo.breakthru.test, fs-tech-1@demo.breakthru.test and so on (see src/lib/demo.ts).
 * In a deployed app, admins use the "Load demo" button (POST /api/admin/demo) instead; those demo users have no password.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { loadDemoWorkspace } from "../src/lib/demo";
import { demoSeedConfig } from "../src/lib/demo-seed-config";
import * as schema from "../src/lib/db/schema";

// Check first, before touching the database.
const { password } = demoSeedConfig();
const { DATABASE_URL } = process.env;
if (!DATABASE_URL) throw new Error("DATABASE_URL is not set");

const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
try {
  const db = drizzle(sql, { schema });
  const summary = await db.transaction((tx) => loadDemoWorkspace(tx, { password }));
  console.log("Demo workspace loaded:", summary);
} finally {
  await sql.end();
}
