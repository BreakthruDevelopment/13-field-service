import { redirect } from "next/navigation";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { homeFor } from "@/lib/auth/rbac";

export const dynamic = "force-dynamic";

/** Sign-in lands here; each role goes to its own home page (`/waiting` until an admin grants a role). */
export default async function DashboardPage() {
  const user = await requireUserOrRedirect();
  redirect(homeFor(user.role));
}
