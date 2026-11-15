"use client";

import { useActionState, useRef } from "react";
import { useRouter } from "next/navigation";
import { buttonPrimary, buttonSecondary, inputClass } from "@/components/ui/styles";
import { GRANTABLE_ROLES, type GrantableRole, type Role } from "@/lib/auth/rbac";
import { type KeyedOp, opFor } from "@/lib/client-op";
import { type AdminActionState, loadDemoAction, setRoleAction } from "./actions";

const ROLE_LABELS: Record<GrantableRole, string> = {
  user: "Waiting for access",
  technician: "Technician",
  dispatcher: "Dispatcher",
};

function FormError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="mt-1 text-sm font-medium text-danger">
      {message}
    </p>
  );
}

function FormStatus({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="status" className="mt-1 text-sm font-medium">
      {message}
    </p>
  );
}

function useAdminForm(
  action: (prev: AdminActionState, form: FormData) => Promise<AdminActionState>,
  fields: string[],
) {
  const router = useRouter();
  const op = useRef<KeyedOp | null>(null);
  return useActionState<AdminActionState, FormData>(async (prev, form) => {
    const payload: Record<string, FormDataEntryValue | null> = {};
    for (const field of fields) payload[field] = form.get(field);
    op.current = opFor(op.current, payload);
    form.set("clientOpId", op.current.id);
    try {
      const result = await action(prev, form);
      if (result.ok) {
        op.current = null;
        router.refresh();
      } else {
        router.refresh();
      }
      return result;
    } catch {
      return { error: "Couldn't reach the server. Try again." };
    }
  }, {});
}

export function RoleForm({
  userId,
  name,
  role,
}: {
  userId: string;
  name: string;
  role: Role;
}) {
  const [state, action, pending] = useAdminForm(setRoleAction, ["userId", "role", "from"]);
  const current = (GRANTABLE_ROLES as readonly string[]).includes(role) ? (role as GrantableRole) : "user";
  return (
    <form action={action} className="min-w-0 space-y-2">
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="from" value={role} />
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
        <label className="min-w-0 flex-1">
          <span className="sr-only">Role for {name}</span>
          <select name="role" defaultValue={current} className={inputClass} disabled={pending}>
            {GRANTABLE_ROLES.map((value) => (
              <option key={value} value={value}>
                {ROLE_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={pending} className={`${buttonSecondary} w-full sm:w-auto`}>
          {pending ? "Saving…" : "Save role"}
        </button>
      </div>
      <FormError message={state.error} />
      <FormStatus message={state.message} />
    </form>
  );
}

export function DemoButton() {
  const [state, action, pending] = useAdminForm(loadDemoAction, []);
  return (
    <form action={action} className="min-w-0 space-y-3">
      <p className="text-muted">
        Reloads the demo workspace: 2 dispatchers, 3 technicians, 8 customers, 12 sites, 60 parts and 15 jobs. Demo
        accounts have no password. Loading again replaces demo customers, sites and jobs, and keeps the demo users and
        parts. 3 loads per hour, 20 per day.
      </p>
      <button type="submit" disabled={pending} className={`${buttonPrimary} w-full sm:w-auto`}>
        {pending ? "Loading…" : "Load demo workspace"}
      </button>
      <FormError message={state.error} />
      <FormStatus message={state.message} />
    </form>
  );
}
