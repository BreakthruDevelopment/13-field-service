import type { ReactNode } from "react";
import { ServiceWorkerRegister } from "@/components/service-worker-register";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { TechDataProvider } from "@/lib/offline/use-tech-data";

export const dynamic = "force-dynamic";

/**
 * Everything under /tech works offline. The layout knows the signed-in technician, so the offline data is opened for that
 * user (and any other user's data on the device is deleted). It renders no job data: the service worker caches this shell.
 */
export default async function TechLayout({ children }: { children: ReactNode }) {
  const user = await requireRoleOrRedirect("technician");
  return (
    <TechDataProvider userId={user.id}>
      <ServiceWorkerRegister />
      {children}
    </TechDataProvider>
  );
}
