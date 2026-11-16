import type { Metadata } from "next";
import Link from "next/link";
import { ZodError } from "zod";
import { type Column, DataList, FilterBar, PageIntro, Panel, StatGrid, StatTile, StatusBadge, buttonSecondary } from "@/components/ui";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { PART_UNITS } from "@/lib/db/schema";
import { HttpError } from "@/lib/errors";
import { MAX_PARTS, type PartDto, listParts } from "@/lib/parts";
import { AddPartForm, PartActions, type PartRow } from "./forms";

export const metadata: Metadata = { title: "Parts" };
export const dynamic = "force-dynamic";
export const maxDuration = 25;

const LIMIT = 50;
const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

function partsHref(opts: { q: string; includeInactive: boolean; view: string; offset: number }) {
  const params = new URLSearchParams();
  if (opts.q) params.set("q", opts.q);
  if (opts.includeInactive) params.set("includeInactive", "true");
  if (opts.view === "cards") params.set("view", "cards");
  if (opts.offset) params.set("offset", String(opts.offset));
  const query = params.toString();
  return query ? `/parts?${query}` : "/parts";
}

export default async function PartsPage({ searchParams }: PageProps<"/parts">) {
  const user = await requireRoleOrRedirect("dispatcher");
  const sp = await searchParams;
  const q = one(sp.q).trim().slice(0, 100);
  const includeInactive = one(sp.includeInactive) === "true";
  const view = one(sp.view) === "cards" ? "cards" : "table";
  const offsetRaw = Number(one(sp.offset));
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.min(Math.floor(offsetRaw), 10_000) : 0;

  let listed: { parts: PartDto[]; hasMore: boolean } | null = null;
  let loadError: string | null = null;
  try {
    listed = await listParts(user, {
      q: q || undefined,
      includeInactive: includeInactive ? "true" : "false",
      limit: LIMIT,
      offset,
    });
  } catch (err) {
    if (err instanceof ZodError) loadError = err.issues[0]?.message ?? "Check the search and try again.";
    else if (err instanceof HttpError && err.status === 429) loadError = "Too many requests, try again in a minute.";
    else throw err;
  }

  const rows = listed?.parts ?? [];
  const columns: Column<PartDto>[] = [
    {
      key: "sku",
      header: "SKU",
      primary: true,
      className: "font-mono",
      cell: (part) => <span className="font-mono [overflow-wrap:anywhere]">{part.sku}</span>,
    },
    {
      key: "name",
      header: "Name",
      cell: (part) => <span className="[overflow-wrap:anywhere]">{part.name}</span>,
    },
    { key: "unit", header: "Unit", cell: (part) => part.unit },
    {
      key: "aliases",
      header: "Aliases",
      cell: (part) => <span className="[overflow-wrap:anywhere]">{part.aliases.length ? part.aliases.join(", ") : "—"}</span>,
    },
    { key: "max", header: "Max / job", cell: (part) => part.maxPerJob },
    {
      key: "status",
      header: "Status",
      cell: (part) =>
        part.active ? <StatusBadge status="live" label="Active" /> : <StatusBadge status="not-started" label="Inactive" />,
    },
    {
      key: "actions",
      header: "Edit",
      srOnlyHeader: true,
      hideLabel: true,
      className: "min-w-0 sm:w-64",
      cell: (part) => <PartActions part={part as PartRow} units={PART_UNITS} />,
    },
  ];

  return (
    <>
      <PageIntro
        section="Parts"
        title="Parts catalog"
        description="The SKU is what the AI work order matches on, so it is set when you add a part and never changes. Search, edit or deactivate parts here."
      />
      <StatGrid>
        <StatTile value={rows.length} label="Parts on this page" tone="accent" />
        <StatTile value={MAX_PARTS} label="Catalog cap" />
      </StatGrid>
      <Panel title="Add a part">
        <AddPartForm units={PART_UNITS} />
      </Panel>
      <Panel title="Catalog" count={rows.length}>
        <FilterBar
          label="Filter parts"
          search={{ value: q, placeholder: "Search SKU, name or alias…" }}
          filters={[
            {
              name: "includeInactive",
              label: "Status",
              value: includeInactive ? "true" : "false",
              options: [
                { value: "false", label: "Active only" },
                { value: "true", label: "Include inactive" },
              ],
            },
          ]}
          view={{ value: view }}
        />
        {loadError ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {loadError}
          </p>
        ) : (
          <DataList
            caption="Parts"
            rows={rows}
            rowKey={(part) => part.id}
            columns={columns}
            view={view}
            empty={
              q
                ? "No parts match that search."
                : includeInactive
                  ? "No parts yet. Add one above."
                  : "No active parts. Add one above, or include inactive."
            }
          />
        )}
        {(offset > 0 || listed?.hasMore) && (
          <div className="mt-4 flex flex-wrap gap-3">
            {offset > 0 && (
              <Link
                href={partsHref({ q, includeInactive, view, offset: Math.max(0, offset - LIMIT) })}
                className={buttonSecondary}
              >
                Previous
              </Link>
            )}
            {listed?.hasMore && (
              <Link href={partsHref({ q, includeInactive, view, offset: offset + LIMIT })} className={buttonSecondary}>
                Next
              </Link>
            )}
          </div>
        )}
      </Panel>
    </>
  );
}
