import type { Metadata } from "next";
import { PageIntro } from "@/components/ui";
import { requireRoleOrRedirect } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Waiting for access" };
export const dynamic = "force-dynamic";

/** Placeholder so the role redirects land somewhere; the UI issue replaces this page. */
export default async function Page() {
  await requireRoleOrRedirect("user");
  return <PageIntro section="Waiting for access" title="Waiting for access" description="An admin needs to give you access. Ask your dispatcher or administrator, then sign in again." />;
}
