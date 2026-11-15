import type { Metadata } from "next";
import { PageIntro } from "@/components/ui";
import { requireRoleOrRedirect } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Schedule board" };
export const dynamic = "force-dynamic";

/** Placeholder so the role redirects land somewhere; the UI issue replaces this page. */
export default async function Page() {
  await requireRoleOrRedirect("dispatcher");
  return <PageIntro section="Board" title="Schedule board" description="The schedule board is being built." />;
}
