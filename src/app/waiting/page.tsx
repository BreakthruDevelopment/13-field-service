import type { Metadata } from "next";
import { PageIntro, Panel } from "@/components/ui";
import { requireRoleOrRedirect } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Waiting for access" };
export const dynamic = "force-dynamic";

/** A new sign-up has no role until an admin grants technician or dispatcher (decision D2). */
export default async function Page() {
  await requireRoleOrRedirect("user");
  return (
    <>
      <PageIntro section="Waiting for access" title="Waiting for access" description="An admin needs to give you access." />
      <Panel title="What happens next">
        <p className="max-w-2xl text-muted">
          Ask a dispatcher or an administrator to grant you a technician or dispatcher role. Sign out and sign in again once they have.
        </p>
      </Panel>
    </>
  );
}
