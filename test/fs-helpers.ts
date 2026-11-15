/** Shared setup for the field-service integration tests (not a test file itself). */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type { Actor, Role } from "@/lib/auth/rbac";

export const testDatabaseUrl = process.env.TEST_DATABASE_URL;

export type TestUser = Actor & { name: string };

/** `prefix` keeps each test file's rows apart and lets cleanup delete exactly them. */
export async function setup(prefix: string, people: Record<string, Role>) {
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
  process.env.APP_URL = "http://localhost:3000";
  const sql = postgres(testDatabaseUrl!, { max: 2, onnotice: () => {} });
  await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
  await clean(sql, prefix);
  const users: Record<string, TestUser> = {};
  for (const [key, role] of Object.entries(people)) {
    const id = `${prefix}-${key}`;
    await sql`insert into "user" (id, name, email, role) values (${id}, ${`${key} ${prefix}`}, ${`${id}@test.local`}, ${role})`;
    users[key] = { id, role, name: `${key} ${prefix}` };
  }
  return { sql, users };
}

/** Deletes the test users (those with ids `prefix-*`, or emails `prefix-*@test.local` for Better Auth sign-ups) and what they made. */
export async function clean(sql: postgres.Sql, prefix: string) {
  const mine = sql`(select id from "user" where id like ${`${prefix}-%`} or email like ${`${prefix}-%@test.local`})`;
  await sql`delete from demo_load_op where admin_id in ${mine}`;
  await sql`delete from role_change_op where admin_id in ${mine}`;
  await sql`delete from work_order_op where actor_id in ${mine}`;
  await sql`delete from service_job where created_by in ${mine} or assignee_id in ${mine}`;
  await sql`delete from customer where created_by in ${mine}`;
  await sql`delete from part where created_by in ${mine}`;
  await sql`delete from sync_op where actor_id in ${mine}`;
  await sql`delete from job_event where actor_id in ${mine}`;
  await sql`delete from job_note where author_id in ${mine}`;
  await sql`delete from "user" where id like ${`${prefix}-%`} or email like ${`${prefix}-%@test.local`}`;
}

export const uuid = () => crypto.randomUUID();

/** A start/end window `hours` long, starting `fromNow` hours from now. */
export function window(fromNow = 2, hours = 1) {
  const start = new Date(Date.now() + fromNow * 3600_000);
  start.setMinutes(0, 0, 0);
  return { scheduledStart: start.toISOString(), scheduledEnd: new Date(start.getTime() + hours * 3600_000).toISOString() };
}
