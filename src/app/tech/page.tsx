import type { Metadata } from "next";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { PART_UNITS } from "@/lib/db/schema";
import { TechHome } from "./tech-home";

export const metadata: Metadata = { title: "My jobs" };
export const dynamic = "force-dynamic";
export const maxDuration = 25;

/**
 * The cached shell. Job rows are drawn by the client from `useTechData()` after load, so this HTML never contains a
 * customer's name, phone, address or notes. The service worker can store it.
 */
export default async function Page() {
  await requireRoleOrRedirect("technician");
  return <TechHome units={[...PART_UNITS]} />;
}
