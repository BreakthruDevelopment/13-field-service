import type { ReactNode } from "react";
import { E2eOfflineHarness } from "@/components/e2e-offline-harness";
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
      {/* Only for the scripted browser run (scripts/e2e-offline.mjs); never set in production. */}
      {process.env.E2E_OFFLINE === "1" ? <E2eOfflineHarness /> : null}
      {children}
    </TechDataProvider>
  );
}
