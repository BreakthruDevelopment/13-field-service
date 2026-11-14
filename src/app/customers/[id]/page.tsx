import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ZodError } from "zod";
import { type Column, DataList, PageIntro, Panel, StatGrid, StatTile, StatusBadge, buttonSecondary } from "@/components/ui";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { osmUrl, parseCoord } from "@/lib/check-in";
import { mailHref, telHref } from "@/lib/contact";
import { type CustomerDetail, type CustomerJob, getCustomer } from "@/lib/customers";
import { NotFoundError } from "@/lib/errors";
import { formatWindow, jobStatusLabel, jobStatusTone } from "@/lib/dispatch-view";
import { CreateSiteForm, EditCustomerForm, EditSiteForm } from "../forms";

export const metadata: Metadata = { title: "Customer" };
export const dynamic = "force-dynamic";

function MapLink({ lat, lng }: { lat: string | null; lng: string | null }) {
  const la = parseCoord(lat);
  const ln = parseCoord(lng);
  if (la == null || ln == null || !lat || !lng) return null;
  return (
    <p className="text-sm">
      <span className="font-mono break-all">
        {lat}, {lng}
      </span>{" "}
      <a href={osmUrl(la, ln, 5)} target="_blank" rel="noopener noreferrer" className="font-semibold text-accent hover:underline">
        OpenStreetMap <span className="sr-only">(opens in a new tab)</span>
      </a>
    </p>
  );
}

export default async function CustomerDetailPage({ params }: PageProps<"/customers/[id]">) {
  const user = await requireRoleOrRedirect("dispatcher");
  const { id } = await params;
  let customer: CustomerDetail;
  try {
    customer = await getCustomer(user, id);
  } catch (err) {
    if (err instanceof NotFoundError || err instanceof ZodError) notFound();
    throw err;
  }

  const tel = customer.phone ? telHref(customer.phone) : null;
  const mail = customer.email ? mailHref(customer.email) : null;
  const columns: Column<CustomerJob>[] = [
    {
      key: "title",
      header: "Job",
      primary: true,
      cell: (job) => (
        <Link href={`/jobs/${job.id}`} className="font-semibold break-words text-accent hover:underline">
          <span className="mr-2 font-mono text-sm text-muted">#{job.number}</span>
          {job.title}
        </Link>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (job) => <StatusBadge status={jobStatusTone(job.status)} label={jobStatusLabel(job.status)} />,
    },
    {
      key: "when",
      header: "When",
      cell: (job) => <span className="break-words">{formatWindow(job.scheduledStart, job.scheduledEnd)}</span>,
    },
    {
      key: "tech",
      header: "Technician",
      cell: (job) => <span className="break-words">{job.assigneeName ?? "Unassigned"}</span>,
    },
  ];

  return (
    <>
      <PageIntro section="Customer" title={customer.name} description="Sites, access notes and the jobs booked here." />
      <p className="mb-6">
        <Link href="/customers" className={buttonSecondary}>
          All customers
        </Link>
      </p>
      <StatGrid>
        <StatTile value={customer.sites.length} label="Sites" tone="accent" />
        <StatTile value={customer.jobs.length} label="Jobs" />
      </StatGrid>

      <Panel title="Customer">
        <div className="mb-4 space-y-1 text-sm">
          {tel ? (
            <a href={tel} className="font-semibold text-accent hover:underline break-words">
              {customer.phone}
            </a>
          ) : customer.phone ? (
            <p className="break-words">{customer.phone}</p>
          ) : null}
          {mail && customer.email ? (
            <p>
              <a href={mail} className="text-accent hover:underline break-all">
                {customer.email}
              </a>
            </p>
          ) : null}
          {customer.notes ? <p className="break-words text-muted">{customer.notes}</p> : null}
        </div>
        <EditCustomerForm key={customer.version} customer={customer} />
      </Panel>

      <Panel title="Sites" count={customer.sites.length}>
        {customer.sites.length === 0 ? (
          <p className="mb-4 rounded-card bg-background px-4 py-6 text-center text-sm text-muted">No sites yet. Add the first one below.</p>
        ) : (
          <ul className="mb-6 grid gap-4">
            {customer.sites.map((site) => (
              <li key={site.id} className="min-w-0 space-y-3 rounded-card border border-border p-4">
                <h3 className="font-semibold break-words">{site.label}</h3>
                <p className="break-words">{site.address}</p>
                {site.accessNotes ? <p className="break-words text-sm text-muted">{site.accessNotes}</p> : null}
                <MapLink lat={site.lat} lng={site.lng} />
                <EditSiteForm key={`${site.id}-${site.version}`} site={site} />
              </li>
            ))}
          </ul>
        )}
        {customer.sitesTruncated ? <p className="mb-4 text-sm text-muted">Showing the first 100 sites.</p> : null}
        <h3 className="mb-3 font-display text-xl font-semibold">Add a site</h3>
        <CreateSiteForm customerId={customer.id} />
      </Panel>

      <Panel title="Job history" count={customer.jobs.length}>
        <DataList
          caption="Jobs for this customer"
          columns={columns}
          rows={customer.jobs}
          rowKey={(job) => job.id}
          empty="No jobs yet."
        />
        {customer.jobsTruncated ? <p className="mt-3 text-sm text-muted">Showing the latest 100 jobs.</p> : null}
      </Panel>
    </>
  );
}
