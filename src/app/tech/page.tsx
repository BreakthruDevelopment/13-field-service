import type { Metadata } from "next";
import { z } from "zod";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { buildId } from "@/lib/build-id";
import { TechApp } from "./tech-app";

export const metadata: Metadata = { title: "My jobs" };
export const dynamic = "force-dynamic";

/** The installable shell. Job rows come from the phone after load, not from this render. */
export default async function TechPage({ searchParams }: PageProps<"/tech">) {
  const user = await requireRoleOrRedirect("technician");
  const sp = await searchParams;
  const raw = Array.isArray(sp.job) ? sp.job[0] : sp.job;
  const initialJobId = raw && z.string().uuid().safeParse(raw).success ? raw : null;
  return <TechApp userId={user.id} initialJobId={initialJobId} buildId={buildId()} />;
}
