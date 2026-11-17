"use client";

import { useActionState, useRef } from "react";
import { useRouter } from "next/navigation";
import { type KeyedOp, opFor } from "@/lib/client-op";
import type { ActionState } from "@/lib/form-errors";

type Options = {
  /** Fields that define the intent. A change mints a new op id; a retry of the same fields reuses it. */
  opFields?: string[];
  /** Notes use `opId`. Creates and work-order decisions use `clientOpId`. */
  opName?: "clientOpId" | "opId";
  /** Adjust the form (for example turn a local time into an ISO string) before the op id is chosen. */
  prepare?: (form: FormData) => void;
  /** Return `"leave"` when navigating away, so a lost response can still retry with the same op id. */
  onOk?: (result: ActionState) => void | "leave";
};

/**
 * `useActionState` plus the op-id ref. The id is cleared only after the server answers ok.
 * A thrown request keeps it, so the retry hits the unique op id and does not create a second row.
 */
export function useSavedForm(
  action: (prev: ActionState, form: FormData) => Promise<ActionState>,
  options: Options = {},
) {
  const op = useRef<KeyedOp | null>(null);
  const router = useRouter();
  const { opFields, prepare, onOk } = options;
  const opName = options.opName ?? "clientOpId";
  return useActionState<ActionState, FormData>(async (prev, form) => {
    prepare?.(form);
    if (opFields) {
      const payload: Record<string, FormDataEntryValue | null> = {};
      for (const field of opFields) payload[field] = form.get(field);
      op.current = opFor(op.current, payload);
      form.set(opName, op.current.id);
    }
    try {
      const result = await action(prev, form);
      if (result.ok) {
        const leave = onOk?.(result) === "leave";
        if (!leave) {
          op.current = null;
          router.refresh();
        }
      } else if (result.conflict) {
        router.refresh();
      }
      return result;
    } catch {
      return { error: "Couldn't reach the server. Try again." };
    }
  }, {});
}
