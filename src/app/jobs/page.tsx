import type { Metadata } from "next";
import { PageIntro } from "@/components/ui";
import { requireRoleOrRedirect } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Jobs" };
export const dynamic = "force-dynamic";

/** Placeholder so the nav link lands somewhere; the UI issue replaces this page. */
export default async function Page() {
  await requireRoleOrRedirect("dispatcher");
  return <PageIntro section="Jobs" title="Jobs" description="This page is being built." />;
}
