import type { Metadata } from "next";
import Link from "next/link";
import { ZodError } from "zod";
import { EmailLink, PhoneLink, wrapText } from "@/components/fact";
import { type Column, DataList, FilterBar, PageIntro, Panel, StatGrid, StatTile, buttonSecondary } from "@/components/ui";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { type CustomerDto, listCustomers } from "@/lib/customers";
import { HttpError } from "@/lib/errors";
import { AddCustomerForm } from "./forms";

export const metadata: Metadata = { title: "Customers" };
export const dynamic = "force-dynamic";
export const maxDuration = 25;

const LIMIT = 50;
const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

type CustomerRow = CustomerDto & { siteCount: number };

function customersHref(opts: { q: string; view: string; offset: number }) {
  const params = new URLSearchParams();
  if (opts.q) params.set("q", opts.q);
  if (opts.view === "cards") params.set("view", "cards");
  if (opts.offset) params.set("offset", String(opts.offset));
  const query = params.toString();
  return query ? `/customers?${query}` : "/customers";
}

export default async function CustomersPage({ searchParams }: PageProps<"/customers">) {
  const user = await requireRoleOrRedirect("dispatcher");
  const sp = await searchParams;
  const q = one(sp.q).trim().slice(0, 100);
  const view = one(sp.view) === "cards" ? "cards" : "table";
  const offsetRaw = Number(one(sp.offset));
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.min(Math.floor(offsetRaw), 10_000) : 0;

  let rows: CustomerRow[] = [];
  let hasMore = false;
  let loadError: string | null = null;
  try {
    const listed = await listCustomers(user, { q: q || undefined, limit: LIMIT, offset });
    rows = listed.customers;
    hasMore = listed.hasMore;
  } catch (err) {
    if (err instanceof ZodError) loadError = err.issues[0]?.message ?? "Check the search and try again.";
    else if (err instanceof HttpError && err.status === 429) loadError = "Too many requests. Try again in a minute.";
    else throw err;
  }

  const columns: Column<CustomerRow>[] = [
    {
      key: "name",
      header: "Name",
      primary: true,
      cell: (customer) => (
        <Link href={`/customers/${customer.id}`} className={`${wrapText} font-semibold text-accent hover:underline`}>
          {customer.name}
        </Link>
      ),
    },
    {
      key: "phone",
      header: "Phone",
      cell: (customer) => <PhoneLink phone={customer.phone} />,
    },
    {
      key: "email",
      header: "Email",
      cell: (customer) => (customer.email ? <EmailLink email={customer.email} /> : "—"),
    },
    { key: "sites", header: "Sites", cell: (customer) => customer.siteCount },
  ];

  return (
    <>
      <PageIntro
        section="Customers"
        title="Customers"
        description="People and companies you send technicians to. Open a customer to add sites and see their jobs."
      />
      <StatGrid>
        <StatTile value={rows.length} label="Customers on this page" tone="accent" />
      </StatGrid>
      <Panel title="Add a customer">
        <AddCustomerForm />
      </Panel>
      <Panel title="All customers" count={rows.length}>
        <FilterBar
          label="Filter customers"
          search={{ value: q, placeholder: "Search name, phone or email…" }}
          view={{ value: view }}
        />
        {loadError ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {loadError}
          </p>
        ) : (
          <DataList
            caption="Customers"
            rows={rows}
            rowKey={(customer) => customer.id}
            columns={columns}
            view={view}
            empty={q ? "No customers match that search." : "No customers yet. Add one above."}
          />
        )}
        {(offset > 0 || hasMore) && (
          <div className="mt-4 flex flex-wrap gap-3">
            {offset > 0 && (
              <Link href={customersHref({ q, view, offset: Math.max(0, offset - LIMIT) })} className={`${buttonSecondary} w-full sm:w-auto`}>
                Previous
              </Link>
            )}
            {hasMore && (
              <Link href={customersHref({ q, view, offset: offset + LIMIT })} className={`${buttonSecondary} w-full sm:w-auto`}>
                Next
              </Link>
            )}
          </div>
        )}
      </Panel>
    </>
  );
}
