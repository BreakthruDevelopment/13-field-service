import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PageIntro } from "@/components/ui";
import { homeFor, requireUserOrRedirect } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Waiting for access" };
export const dynamic = "force-dynamic";

export default async function WaitingPage() {
  const user = await requireUserOrRedirect();
  if (user.role !== "user") redirect(homeFor(user.role));
  return (
    <PageIntro
      section="Access"
      title="An admin needs to give you access"
      description="You can sign in. Jobs stay hidden until an admin grants a technician or dispatcher role."
    />
  );
}
