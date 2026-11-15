import type { Metadata } from "next";
import { ZodError } from "zod";
import { type Column, DataList, FilterBar, PageIntro, Panel, StatGrid, StatTile } from "@/components/ui";
import { type AdminStats, type DirectoryUser, getAdminStats, listUsers } from "@/lib/admin";
import { type Role, ROLES } from "@/lib/auth/rbac";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { SERVICE_JOB_STATUSES } from "@/lib/db/schema";
import { DemoButton, RoleForm } from "./forms";

export const metadata: Metadata = { title: "Admin" };
export const dynamic = "force-dynamic";
export const maxDuration = 25;

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

const JOB_STATUS_LABELS: Record<(typeof SERVICE_JOB_STATUSES)[number], string> = {
  unassigned: "Unassigned",
  scheduled: "Scheduled",
  en_route: "En route",
  on_site: "On site",
  on_hold: "On hold",
  completed: "Completed",
  cancelled: "Cancelled",
};

const ROLE_LABELS: Record<Role, string> = {
  user: "Waiting for access",
  technician: "Technician",
  dispatcher: "Dispatcher",
  admin: "Admin",
};

const SYNC_LABELS = {
  applied: "Applied",
  conflict: "Conflict",
  rejected: "Rejected",
  pending: "Pending",
} as const;

export default async function AdminPage({ searchParams }: PageProps<"/admin">) {
  const admin = await requireRoleOrRedirect("admin");
  const sp = await searchParams;
  const q = one(sp.q).trim().slice(0, 100);
  const view = one(sp.view) === "cards" ? "cards" : "table";

  let stats: AdminStats | null = null;
  let users: DirectoryUser[] = [];
  let loadError: string | null = null;
  try {
    const [s, listed] = await Promise.all([getAdminStats(admin), listUsers(admin, { q: q || undefined, limit: 100 })]);
    stats = s;
    users = listed.users;
  } catch (err) {
    if (err instanceof ZodError) loadError = err.issues[0]?.message ?? "Check the search and try again.";
    else throw err;
  }

  const jobTotal = stats ? SERVICE_JOB_STATUSES.reduce((n, status) => n + stats.jobsByStatus[status], 0) : 0;
  const userTotal = stats ? ROLES.reduce((n, role) => n + stats.usersByRole[role], 0) : 0;

  type StatusRow = { status: (typeof SERVICE_JOB_STATUSES)[number]; count: number };
  const statusRows: StatusRow[] = SERVICE_JOB_STATUSES.map((status) => ({
    status,
    count: stats?.jobsByStatus[status] ?? 0,
  }));
  const statusColumns: Column<StatusRow>[] = [
    { key: "status", header: "Status", primary: true, cell: (row) => JOB_STATUS_LABELS[row.status] },
    { key: "count", header: "Jobs", cell: (row) => row.count },
  ];

  type RoleRow = { role: Role; count: number };
  const roleRows: RoleRow[] = ROLES.map((role) => ({ role, count: stats?.usersByRole[role] ?? 0 }));
  const roleColumns: Column<RoleRow>[] = [
    { key: "role", header: "Role", primary: true, cell: (row) => ROLE_LABELS[row.role] },
    { key: "count", header: "Users", cell: (row) => row.count },
  ];

  type SyncRow = { outcome: keyof typeof SYNC_LABELS; count: number };
  const syncRows: SyncRow[] = (Object.keys(SYNC_LABELS) as (keyof typeof SYNC_LABELS)[]).map((outcome) => ({
    outcome,
    count: stats?.syncOutcomes[outcome] ?? 0,
  }));
  const syncColumns: Column<SyncRow>[] = [
    { key: "outcome", header: "Outcome", primary: true, cell: (row) => SYNC_LABELS[row.outcome] },
    { key: "count", header: "Ops (7 days)", cell: (row) => row.count },
  ];

  const userColumns: Column<DirectoryUser>[] = [
    { key: "name", header: "Name", primary: true, cell: (u) => <span className="break-words">{u.name}</span> },
    {
      key: "email",
      header: "Email",
      className: "break-all",
      cell: (u) => <span className="break-all">{u.email}</span>,
    },
    {
      key: "role",
      header: "Role",
      cell: (u) =>
        u.role === "admin" ? (
          <span className="inline-flex rounded-md bg-accent-soft px-2 py-0.5 text-sm font-medium text-accent">Admin</span>
        ) : (
          ROLE_LABELS[u.role]
        ),
    },
    {
      key: "joined",
      header: "Joined",
      className: "whitespace-nowrap",
      cell: (u) => u.createdAt.slice(0, 10),
    },
    {
      key: "grant",
      header: "Grant a role",
      hideLabel: true,
      className: "min-w-0 sm:w-72",
      cell: (u) =>
        u.role === "admin" ? (
          <span className="text-sm text-muted">Admin accounts stay admin.</span>
        ) : (
          <RoleForm key={`${u.id}-${u.role}`} userId={u.id} name={u.name} role={u.role} />
        ),
    },
  ];

  return (
    <>
      <PageIntro
        section="Admin"
        title="Counts and access"
        description="Counts only: no job, customer or location content. Grant technician or dispatcher here. New sign-ups wait until you give them a role."
      />
      <StatGrid>
        <StatTile value={jobTotal} label="Jobs" tone="accent" />
        <StatTile value={userTotal} label="Users" />
        <StatTile value={stats ? `${stats.ai.today} / ${stats.ai.cap}` : "—"} label="AI drafts today (UTC)" />
        <StatTile value={stats?.syncOutcomes.applied ?? 0} label="Syncs applied (7 days)" />
      </StatGrid>
      <Panel title="Jobs by status" count={jobTotal}>
        <DataList caption="Jobs by status" rows={statusRows} rowKey={(row) => row.status} columns={statusColumns} empty="No jobs." />
      </Panel>
      <Panel title="Users by role" count={userTotal}>
        <DataList caption="Users by role" rows={roleRows} rowKey={(row) => row.role} columns={roleColumns} empty="No users." />
      </Panel>
      <Panel title="Sync outcomes, last 7 days">
        <DataList caption="Sync outcomes" rows={syncRows} rowKey={(row) => row.outcome} columns={syncColumns} empty="No sync ops in the last 7 days." />
      </Panel>
      <Panel title="Users" count={users.length}>
        <p className="mb-3 text-sm text-muted">
          Technician and dispatcher are granted here only. Revoking technician moves that person&apos;s open jobs back to
          the unassigned tray.
        </p>
        <FilterBar label="Filter users" search={{ value: q, placeholder: "Search name or email…" }} view={{ value: view }} />
        {loadError ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {loadError}
          </p>
        ) : (
          <DataList
            caption="Users"
            rows={users}
            rowKey={(u) => u.id}
            columns={userColumns}
            view={view}
            empty={q ? "No users match that search." : "No users yet."}
          />
        )}
        {users.length === 100 ? <p className="mt-3 text-sm text-muted">Showing the first 100. Refine the search to see others.</p> : null}
      </Panel>
      <Panel title="Demo workspace">
        <DemoButton />
      </Panel>
    </>
  );
}
