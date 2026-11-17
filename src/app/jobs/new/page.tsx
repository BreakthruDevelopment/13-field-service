import type { Metadata } from "next";
import Link from "next/link";
import { ZodError } from "zod";
import { PageIntro, Panel, buttonPrimary, buttonSecondary, inputClass, labelClass } from "@/components/ui";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { listTechnicians } from "@/lib/board";
import { getCustomer, listCustomers } from "@/lib/customers";
import { HttpError } from "@/lib/errors";
import { isTimeZone } from "@/lib/job-display";
import { PreferLocalTz } from "@/components/prefer-local-tz";
import { NewJobForm } from "./form";

export const metadata: Metadata = { title: "New job" };
export const dynamic = "force-dynamic";
export const maxDuration = 25;

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

export default async function NewJobPage({ searchParams }: PageProps<"/jobs/new">) {
  const user = await requireRoleOrRedirect("dispatcher");
  const sp = await searchParams;
  const customerId = one(sp.customerId).trim();
  const tzParam = one(sp.tz).trim();
  const tz = isTimeZone(tzParam) ? tzParam : "UTC";

  let customers: Awaited<ReturnType<typeof listCustomers>>["customers"] = [];
  let technicians: Awaited<ReturnType<typeof listTechnicians>>["technicians"] = [];
  let sites: { id: string; label: string; address: string }[] = [];
  let customerName = "";
  let loadError: string | null = null;
  let customerMissing = false;

  try {
    const [listed, techs] = await Promise.all([
      listCustomers(user, { limit: 100 }),
      listTechnicians(user),
    ]);
    customers = listed.customers;
    technicians = techs.technicians;
    if (customerId) {
      try {
        const detail = await getCustomer(user, customerId);
        sites = detail.sites.map((s) => ({ id: s.id, label: s.label, address: s.address }));
        customerName = detail.customer.name;
      } catch (err) {
        if (err instanceof ZodError || (err instanceof HttpError && err.status === 404)) customerMissing = true;
        else throw err;
      }
    }
  } catch (err) {
    if (err instanceof ZodError) loadError = err.issues[0]?.message ?? "Check the form and try again.";
    else if (err instanceof HttpError && err.status === 429) loadError = "Too many requests, try again in a minute.";
    else throw err;
  }

  return (
    <>
      <PreferLocalTz path="/jobs/new" />
      <PageIntro
        section="Jobs"
        title="New job"
        description="Pick a customer and site, add the work, then optionally assign a technician and a window. The job shows on the schedule board."
        actions={
          <Link href="/jobs" className={buttonSecondary}>
            All jobs
          </Link>
        }
      />

      {loadError ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {loadError}
        </p>
      ) : customers.length === 0 ? (
        <Panel title="Customer">
          <p className="text-sm text-muted">
            No customers yet. Add a customer first, then come back to book a job.
          </p>
          <Link href="/customers" className={`${buttonPrimary} mt-3 inline-flex`}>
            Customers
          </Link>
        </Panel>
      ) : (
        <>
          <Panel title="Customer">
            <form method="get" className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end">
              <input type="hidden" name="tz" value={tz} />
              <label className={`${labelClass} min-w-0 flex-1`}>
                <span>Customer</span>
                <select
                  name="customerId"
                  defaultValue={customerId}
                  required
                  className={inputClass}
                >
                  <option value="">Select a customer</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {c.siteCount ? ` (${c.siteCount} ${c.siteCount === 1 ? "site" : "sites"})` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" className={`${buttonPrimary} w-full sm:w-auto`}>
                Continue
              </button>
            </form>
          </Panel>

          {customerId && customerMissing ? (
            <p role="alert" className="text-sm font-medium text-danger">
              That customer was not found. Pick another.
            </p>
          ) : null}

          {customerId && !customerMissing && customerName && sites.length === 0 ? (
            <Panel title="Site">
              <p className="min-w-0 text-sm text-muted [overflow-wrap:anywhere]">
                {customerName} has no sites yet. Add a site on the customer page, then come back to book a job.
              </p>
              <Link href={`/customers/${customerId}`} className={`${buttonSecondary} mt-3 inline-flex`}>
                Customer page
              </Link>
            </Panel>
          ) : null}

          {customerId && !customerMissing && sites.length > 0 ? (
            <Panel title="Job">
              <NewJobForm
                key={customerId}
                customerId={customerId}
                customerName={customerName}
                sites={sites}
                technicians={technicians}
                tz={tz}
              />
            </Panel>
          ) : null}
        </>
      )}
    </>
  );
}
