import type { ReactNode } from "react";
import { requireRoleOrRedirect } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/** Auth runs in the layout so a signed-out visitor gets a redirect before the loading shell is sent. */
export default async function CustomersLayout({ children }: { children: ReactNode }) {
  await requireRoleOrRedirect("dispatcher");
  return children;
}
