import type { Metadata } from "next";
import Link from "next/link";
import { PageIntro, Panel, buttonSecondary } from "@/components/ui";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { listCustomersWithSites, listTechnicians } from "@/lib/dispatch";
import { NewJobForm } from "./form";

export const metadata: Metadata = { title: "New job" };
export const dynamic = "force-dynamic";

export default async function NewJobPage() {
  const user = await requireRoleOrRedirect("dispatcher");
  const [customers, technicians] = await Promise.all([listCustomersWithSites(user), listTechnicians(user)]);
  const sites = customers.flatMap((customer) =>
    customer.sites.map((site) => ({
      id: site.id,
      customerId: customer.id,
      customerName: customer.name,
      label: site.label,
      address: site.address,
    })),
  );

  return (
    <>
      <PageIntro
        section="Jobs"
        title="New job"
        description="Customer, then site, then the work, then an optional technician and time window."
        actions={
          <Link href="/jobs" className={buttonSecondary}>
            All jobs
          </Link>
        }
      />
      <Panel title="Create and assign">
        {technicians.length === 0 && (
          <p className="mb-4 text-sm text-muted">No technicians yet. You can still save the job and leave it unassigned.</p>
        )}
        <NewJobForm
          customers={customers.map((c) => ({ id: c.id, name: c.name }))}
          sites={sites}
          technicians={technicians}
        />
      </Panel>
    </>
  );
}
