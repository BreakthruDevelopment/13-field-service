import type { Metadata } from "next";
import { PageIntro } from "@/components/ui";
import { requireRoleOrRedirect } from "@/lib/auth/session";

export const metadata: Metadata = { title: "My jobs" };
export const dynamic = "force-dynamic";

/** Placeholder so the role redirects land somewhere; the UI issue replaces this page. */
export default async function Page() {
  await requireRoleOrRedirect("technician");
  return <PageIntro section="My jobs" title="My jobs" description="Your jobs are being built." />;
}
