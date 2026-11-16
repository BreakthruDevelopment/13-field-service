"use client";

import { useActionState, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { buttonDanger, buttonPrimary, buttonSecondary, inputClass, labelClass } from "@/components/ui/styles";
import { type KeyedOp, opFor } from "@/lib/client-op";
import { type PartActionState, createPartAction, updatePartAction } from "./actions";

export type PartRow = {
  id: string;
  sku: string;
  name: string;
  unit: string;
  aliases: string[];
  maxPerJob: number;
  active: boolean;
  version: number;
};

const UNIT_LABELS: Record<string, string> = {
  each: "Each",
  ft: "Feet (ft)",
  m: "Metres (m)",
  box: "Box",
  roll: "Roll",
  l: "Litres (l)",
  kg: "Kilograms (kg)",
  set: "Set",
};

function FormError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-sm font-medium text-danger">
      {message}
    </p>
  );
}

function usePartForm(
  action: (prev: PartActionState, form: FormData) => Promise<PartActionState>,
  fields: string[],
  onOk?: () => void,
) {
  const op = useRef<KeyedOp | null>(null);
  return useActionState<PartActionState, FormData>(async (prev, form) => {
    const payload: Record<string, FormDataEntryValue | null> = {};
    for (const field of fields) payload[field] = form.get(field);
    op.current = opFor(op.current, payload);
    form.set("clientOpId", op.current.id);
    try {
      const result = await action(prev, form);
      if (result.ok) {
        op.current = null;
        onOk?.();
      }
      return result;
    } catch {
      return { error: "Couldn't reach the server. Try again." };
    }
  }, {});
}

function UnitSelect({
  units,
  value,
  onChange,
}: {
  units: readonly string[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <select name="unit" value={value} onChange={(e) => onChange(e.target.value)} className={inputClass}>
      {units.map((unit) => (
        <option key={unit} value={unit}>
          {UNIT_LABELS[unit] ?? unit}
        </option>
      ))}
    </select>
  );
}

const EMPTY_ADD = { sku: "", name: "", unit: "each", aliases: "", maxPerJob: "20" };

export function AddPartForm({ units }: { units: readonly string[] }) {
  const router = useRouter();
  // Controlled, so a failed submit keeps what was typed (React resets uncontrolled fields after every action).
  const [vals, setVals] = useState(EMPTY_ADD);
  const set = (key: keyof typeof EMPTY_ADD) => (value: string) => setVals((v) => ({ ...v, [key]: value }));
  const [state, action, pending] = usePartForm(createPartAction, ["sku", "name", "unit", "aliases", "maxPerJob"], () => {
    setVals(EMPTY_ADD);
    router.refresh();
  });
  return (
    <form action={action} className="min-w-0 space-y-3">
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <label className={`${labelClass} min-w-0`}>
          <span>SKU</span>
          <input
            name="sku"
            required
            minLength={2}
            maxLength={40}
            autoComplete="off"
            spellCheck={false}
            value={vals.sku}
            onChange={(e) => set("sku")(e.target.value)}
            className={`${inputClass} font-mono uppercase`}
            aria-describedby="sku-hint"
          />
        </label>
        <label className={`${labelClass} min-w-0`}>
          <span>Name</span>
          <input
            name="name"
            required
            maxLength={120}
            value={vals.name}
            onChange={(e) => set("name")(e.target.value)}
            className={inputClass}
          />
        </label>
        <label className={`${labelClass} min-w-0`}>
          <span>Unit</span>
          <UnitSelect units={units} value={vals.unit} onChange={set("unit")} />
        </label>
        <label className={`${labelClass} min-w-0`}>
          <span>Max per job</span>
          <input
            name="maxPerJob"
            type="number"
            min={1}
            max={9999}
            value={vals.maxPerJob}
            onChange={(e) => set("maxPerJob")(e.target.value)}
            className={inputClass}
          />
        </label>
        <label className={`${labelClass} min-w-0 sm:col-span-2`}>
          <span>Aliases</span>
          <input
            name="aliases"
            maxLength={700}
            value={vals.aliases}
            onChange={(e) => set("aliases")(e.target.value)}
            className={inputClass}
            aria-describedby="aliases-hint"
          />
        </label>
      </div>
      <p id="sku-hint" className="text-sm text-muted">
        2 to 40 letters, digits or dashes. Set once; the AI work order matches on this SKU.
      </p>
      <p id="aliases-hint" className="text-sm text-muted">
        Optional. Comma-separated, up to 10 names people might type instead of the SKU, each up to 60 characters.
      </p>
      <FormError message={state.error} />
      <button type="submit" disabled={pending} className={`${buttonPrimary} w-full sm:w-auto`}>
        {pending ? "Adding…" : "Add part"}
      </button>
    </form>
  );
}

/** The editable fields. Keyed on the part's version, so after a conflict reload they show the latest values. */
function EditFields({ part, units }: { part: PartRow; units: readonly string[] }) {
  const [unit, setUnit] = useState(part.unit);
  const [name, setName] = useState(part.name);
  const [max, setMax] = useState(String(part.maxPerJob));
  const [aliases, setAliases] = useState(part.aliases.join(", "));
  return (
    <div className="grid min-w-0 gap-3">
      <label className={`${labelClass} min-w-0`}>
        <span>Name</span>
        <input name="name" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
      </label>
      <label className={`${labelClass} min-w-0`}>
        <span>Unit</span>
        <UnitSelect units={units} value={unit} onChange={setUnit} />
      </label>
      <label className={`${labelClass} min-w-0`}>
        <span>Max per job</span>
        <input
          name="maxPerJob"
          type="number"
          min={1}
          max={9999}
          value={max}
          onChange={(e) => setMax(e.target.value)}
          className={inputClass}
          aria-describedby={`max-hint-${part.id}`}
        />
        <span id={`max-hint-${part.id}`} className="text-sm font-normal text-muted">
          Leave empty to keep {part.maxPerJob}.
        </span>
      </label>
      <label className={`${labelClass} min-w-0`}>
        <span>Aliases</span>
        <input name="aliases" maxLength={700} value={aliases} onChange={(e) => setAliases(e.target.value)} className={inputClass} />
        <span className="text-sm font-normal text-muted">Comma-separated, up to 10, each up to 60 characters.</span>
      </label>
    </div>
  );
}

function EditPartForm({ part, units, onDone }: { part: PartRow; units: readonly string[]; onDone?: () => void }) {
  const router = useRouter();
  const [state, action, pending] = useActionState<PartActionState, FormData>(async (prev, form) => {
    try {
      const result = await updatePartAction(prev, form);
      if (result.ok) onDone?.();
      router.refresh();
      return result;
    } catch {
      return { error: "Couldn't reach the server. Try again." };
    }
  }, {});
  return (
    <form action={action} className="min-w-0 space-y-3">
      <input type="hidden" name="id" value={part.id} />
      <input type="hidden" name="version" value={part.version} />
      <EditFields key={part.version} part={part} units={units} />
      <FormError message={state.error} />
      <button type="submit" disabled={pending} className={`${buttonPrimary} w-full sm:w-auto`}>
        {pending ? "Saving…" : "Save part"}
      </button>
    </form>
  );
}

function ActiveToggle({ part }: { part: PartRow }) {
  const router = useRouter();
  const [state, action, pending] = useActionState<PartActionState, FormData>(async (prev, form) => {
    try {
      const result = await updatePartAction(prev, form);
      router.refresh();
      return result;
    } catch {
      return { error: "Couldn't reach the server. Try again." };
    }
  }, {});
  const next = part.active ? "false" : "true";
  return (
    <form action={action} className="min-w-0">
      <input type="hidden" name="id" value={part.id} />
      <input type="hidden" name="version" value={part.version} />
      <input type="hidden" name="active" value={next} />
      <button
        type="submit"
        disabled={pending}
        className={`${part.active ? buttonDanger : buttonSecondary} w-full sm:w-auto`}
        aria-label={part.active ? `Deactivate ${part.name}` : `Reactivate ${part.name}`}
      >
        {pending ? "Saving…" : part.active ? "Deactivate" : "Reactivate"}
      </button>
      <FormError message={state.error} />
    </form>
  );
}

export function PartActions({ part, units }: { part: PartRow; units: readonly string[] }) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="min-w-0 space-y-3">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={`${buttonSecondary} w-full sm:w-auto`}
          aria-expanded={editing}
          onClick={() => setEditing((open) => !open)}
        >
          {editing ? "Close" : "Edit"}
        </button>
        <ActiveToggle part={part} />
      </div>
      {editing && <EditPartForm part={part} units={units} onDone={() => setEditing(false)} />}
    </div>
  );
}
