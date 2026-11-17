import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EmailLink, Fact, FactList, PhoneLink, wrapText } from "@/components/fact";
import { JobStatusBadge } from "@/components/job-status-badge";
import { OsmLink } from "@/components/osm-link";
import { type Column, DataList, PageIntro, Panel, StatGrid, StatTile, buttonSecondary } from "@/components/ui";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { getCustomer } from "@/lib/customers";
import { formatUtc } from "@/lib/field-format";
import { JOB_PRIORITY_LABELS } from "@/lib/job-display";
import { readFailure } from "@/lib/form-errors";
import type { JobSummary } from "@/lib/service-jobs";
import { AddSiteForm, EditCustomerForm, EditSiteForm } from "../forms";

export const metadata: Metadata = { title: "Customer" };
export const dynamic = "force-dynamic";
export const maxDuration = 25;

export default async function CustomerPage({ params }: PageProps<"/customers/[id]">) {
  const user = await requireRoleOrRedirect("dispatcher");
  const { id } = await params;

  let detail: Awaited<ReturnType<typeof getCustomer>>;
  try {
    detail = await getCustomer(user, id);
  } catch (err) {
    const failure = readFailure(err);
    if (failure === "missing") notFound();
    return (
      <>
        <PageIntro section="Customers" title="Customer" description="This couldn't be loaded." />
        <p role="alert" className="text-sm font-medium text-danger">
          {failure}
        </p>
        <Link href="/customers" className={`${buttonSecondary} mt-4 w-full sm:w-auto`}>
          Back to customers
        </Link>
      </>
    );
  }

  const { customer, sites, jobs } = detail;
  const columns: Column<JobSummary>[] = [
    {
      key: "title",
      header: "Job",
      primary: true,
      cell: (job) => (
        <Link href={`/jobs/${job.id}`} className={`${wrapText} font-semibold text-accent hover:underline`}>
          #{job.number} {job.title}
        </Link>
      ),
    },
    { key: "status", header: "Status", cell: (job) => <JobStatusBadge status={job.status} /> },
    { key: "priority", header: "Priority", cell: (job) => JOB_PRIORITY_LABELS[job.priority] },
    { key: "site", header: "Site", cell: (job) => job.site.label },
    { key: "assignee", header: "Technician", cell: (job) => job.assignee?.name || "Unassigned" },
    {
      key: "window",
      header: "Window",
      cell: (job) => (job.scheduledStart ? formatUtc(job.scheduledStart) : "Not scheduled"),
    },
  ];

  return (
    <>
      <PageIntro
        section="Customers"
        title={customer.name}
        description="Sites, access notes and the jobs booked for this customer."
        actions={
          <Link href="/customers" className={`${buttonSecondary} w-full sm:w-auto`}>
            All customers
          </Link>
        }
      />
      <StatGrid>
        <StatTile value={sites.length} label={sites.length === 1 ? "Site" : "Sites"} tone="accent" />
        <StatTile value={jobs.length} label={jobs.length === 1 ? "Job shown" : "Jobs shown"} />
      </StatGrid>
      <Panel title="Customer">
        <FactList>
          <Fact label="Phone">
            <PhoneLink phone={customer.phone} />
          </Fact>
          <Fact label="Email">{customer.email ? <EmailLink email={customer.email} /> : "—"}</Fact>
          <Fact label="Notes" wide>
            {customer.notes ? <span className="whitespace-pre-wrap">{customer.notes}</span> : "No notes."}
          </Fact>
        </FactList>
        <div className="mt-4">
          <EditCustomerForm customer={customer} />
        </div>
      </Panel>
      <Panel title="Sites" count={sites.length}>
        {sites.length === 0 ? (
          <p className="mb-4 rounded-card bg-background px-4 py-6 text-center text-sm text-muted">No sites yet. Add the first one below.</p>
        ) : (
          <ul className="mb-6 grid gap-3">
            {sites.map((site) => (
              <li key={site.id} className="min-w-0 space-y-3 rounded-card border border-border p-4">
                <h3 className={`${wrapText} font-semibold`}>{site.label}</h3>
                <FactList>
                  <Fact label="Address" wide>
                    <span className="whitespace-pre-wrap">{site.address}</span>
                  </Fact>
                  <Fact label="Access notes" wide>
                    {site.accessNotes ? <span className="whitespace-pre-wrap">{site.accessNotes}</span> : "No access notes."}
                  </Fact>
                  <Fact label="Coordinates" wide>
                    {site.lat !== null && site.lng !== null ? (
                      <span className="flex flex-col items-start gap-2">
                        <span>
                          {site.lat}, {site.lng}
                        </span>
                        <OsmLink lat={site.lat} lng={site.lng} />
                      </span>
                    ) : (
                      "No coordinates."
                    )}
                  </Fact>
                </FactList>
                <EditSiteForm customerId={customer.id} site={site} />
              </li>
            ))}
          </ul>
        )}
        <h3 className="mb-3 font-display text-xl font-semibold">Add a site</h3>
        <AddSiteForm customerId={customer.id} />
      </Panel>
      <Panel title="Job history" count={jobs.length}>
        <DataList
          caption="Jobs for this customer"
          rows={jobs}
          rowKey={(job) => job.id}
          columns={columns}
          empty="No jobs for this customer yet."
        />
        {jobs.length === 50 && <p className="mt-3 text-sm text-muted">Showing 50 jobs.</p>}
      </Panel>
    </>
  );
}
