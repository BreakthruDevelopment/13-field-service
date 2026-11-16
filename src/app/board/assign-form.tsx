"use client";

import { useActionState, useRef, useState } from "react";
import { unstable_rethrow, useRouter } from "next/navigation";
import { buttonPrimary, buttonSecondary, inputClass, labelClass } from "@/components/ui/styles";
import { type KeyedOp, opFor } from "@/lib/client-op";
import { type AssignState, assignJobAction } from "./actions";

function FormError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-sm font-medium text-danger">
      {message}
    </p>
  );
}

export function AssignForm({
  jobId,
  version,
  technicians,
  defaultStart,
  defaultEnd,
  tz,
}: {
  jobId: string;
  version: number;
  technicians: { id: string; name: string }[];
  defaultStart: string;
  defaultEnd: string;
  tz: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // One op id per assignment the dispatcher meant to make. It survives a lost response (the catch below leaves it
  // alone), so the retry replays it and the server answers with the assignment that already landed.
  const op = useRef<KeyedOp | null>(null);
  const [state, action, pending] = useActionState<AssignState, FormData>(async (prev, form) => {
    const payload = {
      jobId,
      assigneeId: form.get("assigneeId"),
      scheduledStart: form.get("scheduledStart"),
      scheduledEnd: form.get("scheduledEnd"),
    };
    op.current = opFor(op.current, payload);
    form.set("clientOpId", op.current.id);
    try {
      const result = await assignJobAction(prev, form);
      // The server answered (ok, conflict or validation): this intent is finished with its id.
      op.current = null;
      if (result.ok) setOpen(false);
      // A conflict means the version in this form is stale, so the board has to catch up before the next try —
      // otherwise every retry fails the same way until the 60-second poll comes round.
      if (result.ok || result.conflict) router.refresh();
      return result;
    } catch (err) {
      unstable_rethrow(err);
      return { error: "Couldn't reach the server. Try again." };
    }
  }, {});

  if (technicians.length === 0) {
    return <p className="text-sm text-muted">No technicians to assign yet.</p>;
  }

  return (
    <div className="min-w-0 space-y-2">
      <button
        type="button"
        className={`${buttonSecondary} w-full`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "Close" : "Assign"}
      </button>
      {open && (
        <form action={action} className="min-w-0 space-y-3">
          <input type="hidden" name="jobId" value={jobId} />
          <input type="hidden" name="version" value={version} />
          <input type="hidden" name="tz" value={tz} />
          <label className={`${labelClass} min-w-0`}>
            <span>Technician</span>
            <select name="assigneeId" required defaultValue={technicians[0]?.id} className={inputClass}>
              {technicians.map((tech) => (
                <option key={tech.id} value={tech.id}>
                  {tech.name}
                </option>
              ))}
            </select>
          </label>
          <label className={`${labelClass} min-w-0`}>
            <span>Start</span>
            <input
              type="datetime-local"
              name="scheduledStart"
              required
              defaultValue={defaultStart}
              className={inputClass}
            />
          </label>
          <label className={`${labelClass} min-w-0`}>
            <span>End</span>
            <input
              type="datetime-local"
              name="scheduledEnd"
              required
              defaultValue={defaultEnd}
              className={inputClass}
            />
          </label>
          <FormError message={state.error} />
          <button type="submit" disabled={pending} className={`${buttonPrimary} w-full`}>
            {pending ? "Assigning…" : "Assign job"}
          </button>
        </form>
      )}
    </div>
  );
}
