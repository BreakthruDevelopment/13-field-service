import type { Metadata } from "next";
import Link from "next/link";
import { ZodError } from "zod";
import { type Column, DataList, FilterBar, PageIntro, Panel, StatGrid, StatTile } from "@/components/ui";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { mailHref, telHref } from "@/lib/contact";
import { type CustomerListItem, listCustomers } from "@/lib/customers";
import { CreateCustomerForm } from "./forms";

export const metadata: Metadata = { title: "Customers" };
export const dynamic = "force-dynamic";

const sorts = [
  { value: "name", label: "Name A to Z" },
  { value: "newest", label: "Newest first" },
];

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

function Contact({ phone, email }: { phone: string; email: string | null }) {
  const tel = phone ? telHref(phone) : null;
  const mail = email ? mailHref(email) : null;
  return (
    <span className="break-words">
      {tel ? (
        <a href={tel} className="font-semibold text-accent hover:underline">
          {phone}
        </a>
      ) : (
        phone || "No phone"
      )}
      {mail && email ? (
        <>
          {" · "}
          <a href={mail} className="text-accent hover:underline break-all">
            {email}
          </a>
        </>
      ) : null}
    </span>
  );
}

export default async function CustomersPage({ searchParams }: PageProps<"/customers">) {
  const user = await requireRoleOrRedirect("dispatcher");
  const sp = await searchParams;
  const q = one(sp.q).slice(0, 100);
  const sort = sorts.some((item) => item.value === one(sp.sort)) ? one(sp.sort) : "name";
  const view = one(sp.view) === "cards" ? "cards" : "table";

  let listed: Awaited<ReturnType<typeof listCustomers>> | null = null;
  let loadError: string | null = null;
  try {
    listed = await listCustomers(user, { q, sort });
  } catch (err) {
    if (err instanceof ZodError) loadError = err.issues[0]?.message ?? "Check the search and try again.";
    else throw err;
  }

  const rows = listed?.rows ?? [];
  const columns: Column<CustomerListItem>[] = [
    {
      key: "name",
      header: "Customer",
      primary: true,
      cell: (row) => (
        <Link href={`/customers/${row.id}`} className="font-semibold break-words text-accent hover:underline">
          {row.name}
        </Link>
      ),
    },
    {
      key: "contact",
      header: "Contact",
      cell: (row) => <Contact phone={row.phone} email={row.email} />,
    },
    { key: "sites", header: "Sites", cell: (row) => row.siteCount },
    { key: "jobs", header: "Jobs", cell: (row) => row.jobCount },
  ];

  return (
    <>
      <PageIntro
        section="Customers"
        title="Customers and sites"
        description="Everyone the crew visits. Open a customer to see sites and job history."
      />
      <StatGrid>
        <StatTile value={listed?.total ?? 0} label="Customers" tone="accent" />
        <StatTile value={rows.length} label="Shown" />
      </StatGrid>
      <Panel title="Add a customer">
        <CreateCustomerForm />
      </Panel>
      <Panel title="All customers" count={rows.length}>
        <FilterBar
          label="Filter customers"
          search={{ value: q, placeholder: "Search name, phone or email" }}
          sort={{ name: "sort", label: "Sort", value: sort, options: sorts }}
          view={{ value: view }}
        />
        {loadError ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {loadError}
          </p>
        ) : (
          <DataList
            caption="Customers"
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            view={view}
            empty={q ? "No customers match that search." : "No customers yet. Add one above."}
          />
        )}
        {listed?.truncated ? <p className="mt-3 text-sm text-muted">Showing the first 200. Refine the search to see the rest.</p> : null}
      </Panel>
    </>
  );
}
