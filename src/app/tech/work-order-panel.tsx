"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DemoBadge, Panel, buttonPrimary, buttonSecondary, inputClass, labelClass } from "@/components/ui";
import { type KeyedOp, opFor } from "@/lib/client-op";
import type { JobStatus } from "@/lib/offline/types";
import {
  type PartPick,
  type WorkOrderActionResult,
  type WorkOrderDto,
  type WorkOrderEdit,
  draftWorkOrderAction,
  loadWorkOrderAction,
  saveWorkOrderAction,
  searchPartsAction,
  submitWorkOrderAction,
} from "./actions";
import { FLAG_LABEL, userTextClass } from "./present";

const UNIT_LABEL: Record<string, string> = {
  each: "Each",
  ft: "Feet (ft)",
  m: "Metres (m)",
  box: "Box",
  roll: "Roll",
  l: "Litres (l)",
  kg: "Kilograms (kg)",
  set: "Set",
};

type TaskForm = { key: string; description: string; state: "done" | "to_do" };
type LineForm = { key: string; sku: string; mentioned: string; qty: string; unit: string; used: "used" | "needed"; flags: string[] };
type FormState = { summary: string; followUp: string; tasks: TaskForm[]; lines: LineForm[] };
type Pending = "draft" | "save" | "submit" | null;

const EMPTY_FORM: FormState = { summary: "", followUp: "", tasks: [], lines: [] };

function fromDto(order: WorkOrderDto): FormState {
  return {
    summary: order.summary,
    followUp: order.followUp ?? "",
    tasks: order.tasks.map((task) => ({ key: crypto.randomUUID(), description: task.description, state: task.state })),
    lines: order.lines.map((line) => ({
      key: crypto.randomUUID(),
      sku: line.sku ?? "",
      mentioned: line.mentioned,
      qty: String(line.qty),
      unit: line.unit,
      used: line.used,
      flags: [...line.flags],
    })),
  };
}

function canonical(form: FormState): string {
  return JSON.stringify({
    summary: form.summary.trim(),
    followUp: form.followUp.trim(),
    tasks: form.tasks.map((task) => ({ description: task.description.trim(), state: task.state })),
    lines: form.lines.map((line) => ({
      sku: line.sku.trim().toUpperCase(),
      mentioned: line.mentioned.trim(),
      qty: line.qty.trim(),
      unit: line.unit,
      used: line.used,
    })),
  });
}

function parseForm(form: FormState, units: readonly string[]): { ok: true; value: Omit<WorkOrderEdit, "clientOpId" | "version"> } | { ok: false; error: string } {
  const texts = [form.summary, form.followUp, ...form.tasks.map((task) => task.description), ...form.lines.flatMap((line) => [line.mentioned, line.sku])];
  if (texts.some((value) => value.includes("\0"))) return { ok: false, error: "Text can't contain null characters" };
  const summary = form.summary.trim();
  if (summary.length > 400) return { ok: false, error: "Summary is at most 400 characters." };
  const follow = form.followUp.trim();
  if (follow.length > 300) return { ok: false, error: "Follow-up is at most 300 characters." };
  if (form.tasks.length > 12) return { ok: false, error: "A work order has at most 12 tasks." };
  if (form.lines.length > 30) return { ok: false, error: "A work order has at most 30 parts." };
  const tasks: WorkOrderEdit["tasks"] = [];
  for (const task of form.tasks) {
    const description = task.description.trim();
    if (!description) return { ok: false, error: "Each task needs a description." };
    if (description.length > 200) return { ok: false, error: "A task is at most 200 characters." };
    tasks.push({ description, state: task.state });
  }
  const lines: WorkOrderEdit["lines"] = [];
  for (const line of form.lines) {
    const mentioned = line.mentioned.trim();
    if (!mentioned) return { ok: false, error: "Say what the part is." };
    if (mentioned.length > 120) return { ok: false, error: "A part name is at most 120 characters." };
    const qty = Number(line.qty);
    if (!Number.isFinite(qty) || qty <= 0 || qty > 9999) return { ok: false, error: "Enter a quantity greater than 0." };
    if (!units.includes(line.unit)) return { ok: false, error: "Choose a unit." };
    const sku = line.sku.trim();
    if (sku && !/^[A-Za-z0-9-]{2,40}$/.test(sku)) return { ok: false, error: "SKU is 2 to 40 letters, digits or dashes." };
    lines.push({ sku: sku ? sku.toUpperCase() : null, mentioned, qty, unit: line.unit, used: line.used });
  }
  return { ok: true, value: { summary, tasks, followUp: follow ? follow : null, lines } };
}

function FlagList({ flags }: { flags: readonly string[] }) {
  if (flags.length === 0) return null;
  return (
    <ul className="mt-1 space-y-1">
      {flags.map((flag) => (
        <li key={flag} className="text-sm text-building">
          {FLAG_LABEL[flag] ?? flag}
        </li>
      ))}
    </ul>
  );
}

function SkuField({
  value,
  disabled,
  online,
  onChange,
  onPick,
}: {
  value: string;
  disabled: boolean;
  online: boolean;
  onChange: (sku: string) => void;
  onPick: (part: PartPick) => void;
}) {
  const [focused, setFocused] = useState(false);
  const [hits, setHits] = useState<{ query: string; parts: PartPick[] }>({ query: "", parts: [] });
  const [searchError, setSearchError] = useState<{ query: string; message: string } | null>(null);
  const seq = useRef(0);
  const query = value.trim();
  const searching = focused && online && !disabled && query.length >= 2;

  useEffect(() => {
    if (!searching) return;
    const id = ++seq.current;
    const handle = window.setTimeout(() => {
      void searchPartsAction(query)
        .then((result) => {
          if (seq.current !== id) return;
          if (result.ok) {
            setHits({ query, parts: result.parts });
            setSearchError(null);
          } else {
            setHits({ query, parts: [] });
            setSearchError({ query, message: result.error });
          }
        })
        .catch(() => {
          if (seq.current !== id) return;
          setHits({ query, parts: [] });
          setSearchError({ query, message: "Couldn't search parts." });
        });
    }, 300);
    return () => window.clearTimeout(handle);
  }, [searching, query]);

  const visibleHits = searching && hits.query === query ? hits.parts : [];
  const visibleError = searching && searchError?.query === query ? searchError.message : null;

  return (
    <div className="min-w-0">
      <label className={`${labelClass} min-w-0`}>
        <span>SKU</span>
        <input
          value={value}
          disabled={disabled}
          autoComplete="off"
          maxLength={40}
          onChange={(event) => onChange(event.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="Search the catalog"
          className={inputClass}
        />
      </label>
      {visibleError && (
        <p role="alert" className="mt-1 text-sm font-medium text-danger">
          {visibleError}
        </p>
      )}
      {visibleHits.length > 0 && (
        <ul className="mt-1 max-h-48 overflow-auto rounded-card border border-border bg-surface">
          {visibleHits.map((part) => (
            <li key={part.sku}>
              <button
                type="button"
                className="flex min-h-11 w-full min-w-0 items-center gap-2 px-3 text-left text-sm hover:bg-accent-soft"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onPick(part);
                  setHits({ query: "", parts: [] });
                  setFocused(false);
                }}
              >
                <span className="shrink-0 font-mono">{part.sku}</span>
                <span className={userTextClass}>{part.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function OrderFacts({ order }: { order: WorkOrderDto }) {
  return (
    <div className="min-w-0 space-y-4">
      {order.ai?.demo && <DemoBadge label="Recorded demo, not a live model" />}
      {order.safety.map((chip) => (
        <p key={chip.code} className="rounded-card bg-blocked-soft px-3 py-2 text-sm text-blocked">
          Safety: check before closing — <span className={userTextClass}>{chip.phrase}</span>
        </p>
      ))}
      {order.ai?.needsHumanBecause && <p className={`text-sm ${userTextClass}`}>Needs a person: {order.ai.needsHumanBecause}</p>}
      {order.returnReason && (
        <p role="status" className={`rounded-card bg-building-soft px-3 py-2 text-sm text-building ${userTextClass}`}>
          Returned: {order.returnReason}
        </p>
      )}
      {order.ai && order.ai.dropped.length > 0 && (
        <div>
          <h3 className="text-sm font-medium">Left out of the draft</h3>
          <ul className="mt-1 space-y-1">
            {order.ai.dropped.map((row) => (
              <li key={row.mentioned} className={`text-sm text-muted ${userTextClass}`}>
                {row.mentioned} — not in the notes
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ReadOnlyOrder({ order }: { order: WorkOrderDto }) {
  return (
    <div className="mt-4 min-w-0 space-y-4">
      <div className="min-w-0">
        <h3 className="text-sm font-medium text-muted">Summary</h3>
        <p className={userTextClass}>{order.summary || "No summary."}</p>
      </div>
      <div>
        <h3 className="text-sm font-medium text-muted">Tasks</h3>
        {order.tasks.length === 0 ? (
          <p className="text-sm text-muted">No tasks.</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {order.tasks.map((task, index) => (
              <li key={`${index}-${task.description}`} className={userTextClass}>
                {task.state === "done" ? "Done" : "To do"} — {task.description}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <h3 className="text-sm font-medium text-muted">Parts</h3>
        {order.lines.length === 0 ? (
          <p className="text-sm text-muted">No parts on this work order.</p>
        ) : (
          <ul className="mt-1 space-y-3">
            {order.lines.map((line) => (
              <li key={line.id} className="min-w-0">
                <p className={userTextClass}>
                  {line.qty} {line.unit} · {line.used} · {line.mentioned}
                  {line.sku ? <span className="font-mono"> · {line.sku}</span> : null}
                </p>
                <FlagList flags={line.flags} />
              </li>
            ))}
          </ul>
        )}
      </div>
      {order.followUp && (
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-muted">Follow-up</h3>
          <p className={userTextClass}>{order.followUp}</p>
        </div>
      )}
    </div>
  );
}

export function WorkOrderPanel({
  jobId,
  jobStatus,
  serverNoteCount,
  notesTruncated,
  pendingNoteCount,
  online,
  units,
}: {
  jobId: string;
  jobStatus: JobStatus;
  serverNoteCount: number;
  notesTruncated: boolean;
  pendingNoteCount: number;
  online: boolean;
  units: readonly string[];
}) {
  const [order, setOrder] = useState<WorkOrderDto | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [phase, setPhase] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const orderRef = useRef<WorkOrderDto | null>(null);
  const attempt = useRef(0);
  const busy = useRef(false);
  const draftOp = useRef<KeyedOp | null>(null);
  const saveOp = useRef<KeyedOp | null>(null);
  const submitOp = useRef<KeyedOp | null>(null);
  const cancelled = jobStatus === "cancelled";
  const canDraft = !cancelled && (serverNoteCount > 0 || notesTruncated);
  const editable = !!order && !cancelled && (order.status === "draft" || order.status === "returned");
  const dirty = order ? canonical(form) !== canonical(fromDto(order)) : false;

  const takeOrder = useCallback((next: WorkOrderDto | null) => {
    const prev = orderRef.current;
    const same = !!(next && prev && prev.id === next.id && prev.version === next.version);
    orderRef.current = next;
    setOrder(next);
    if (next && !same) setForm(fromDto(next));
  }, []);

  const load = useCallback(() => {
    const token = ++attempt.current;
    if (!orderRef.current) setPhase("loading");
    setError(null);
    return loadWorkOrderAction(jobId)
      .then((result) => {
        if (attempt.current !== token) return;
        if (!result.ok) {
          setError(result.error ?? "Couldn't load the work order.");
          setPhase(orderRef.current ? "ready" : "error");
          return;
        }
        const previous = orderRef.current?.version ?? null;
        takeOrder(result.workOrder ?? null);
        if (result.workOrder && previous !== null && result.workOrder.version !== previous) {
          setMessage("This work order changed. Showing the latest version.");
        }
        setPhase("ready");
      })
      .catch(() => {
        if (attempt.current !== token) return;
        setError("Couldn't reach the server. Try again.");
        setPhase(orderRef.current ? "ready" : "error");
      });
  }, [jobId, takeOrder]);

  useEffect(() => {
    if (!online) {
      setPhase((current) => (current === "loading" && !orderRef.current ? "idle" : current));
      return;
    }
    void load();
    return () => {
      attempt.current += 1;
    };
  }, [online, load]);

  function settle(result: WorkOrderActionResult, op: { current: KeyedOp | null }, okMessage: string) {
    if (result.workOrder) takeOrder(result.workOrder);
    if (result.ok) {
      op.current = null;
      setError(null);
      setMessage(result.replayed ? "Already saved." : okMessage);
      setPhase("ready");
      return;
    }
    if (result.code === "op_id_reused" || result.code === "stale_version") op.current = null;
    setMessage(null);
    setError(result.error ?? "Couldn't save the work order.");
  }

  async function run(kind: Exclude<Pending, null>, work: () => Promise<void>) {
    if (busy.current) return;
    busy.current = true;
    setPending(kind);
    setError(null);
    setMessage(null);
    try {
      await work();
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      busy.current = false;
      setPending(null);
    }
  }

  function onDraft() {
    void run("draft", async () => {
      const payload = { baseVersion: orderRef.current?.version ?? null };
      draftOp.current = opFor(draftOp.current, payload);
      settle(await draftWorkOrderAction(jobId, draftOp.current.id, payload.baseVersion), draftOp, "Work order drafted.");
    });
  }

  function onSave() {
    if (!order) return;
    const parsed = parseForm(form, units);
    if (!parsed.ok) {
      setError(parsed.error);
      setMessage(null);
      return;
    }
    const version = order.version;
    const value = parsed.value;
    void run("save", async () => {
      const payload = { version, ...value };
      saveOp.current = opFor(saveOp.current, payload);
      settle(await saveWorkOrderAction(jobId, { clientOpId: saveOp.current.id, ...payload }), saveOp, "Changes saved.");
    });
  }

  function onSubmit() {
    if (!order) return;
    const version = order.version;
    void run("submit", async () => {
      const payload = { version };
      submitOp.current = opFor(submitOp.current, payload);
      settle(await submitWorkOrderAction(jobId, submitOp.current.id, payload.version), submitOp, "Submitted. A dispatcher approves it.");
    });
  }

  function updateLine(index: number, patch: Partial<LineForm>) {
    setForm((current) => ({
      ...current,
      lines: current.lines.map((line, i) => (i === index ? { ...line, ...patch, flags: [] } : line)),
    }));
  }

  const lockedReason = cancelled
    ? "This job was cancelled, so its work order can't be changed."
    : order?.status === "submitted"
      ? "Submitted. A dispatcher approves it."
      : order?.status === "approved"
        ? "Approved. This work order can't be changed."
        : null;

  return (
    <Panel title="Work order">
      <div className="min-w-0 space-y-3">
        {!online && <p className="text-sm text-muted">Work orders are drafted online. Reconnect to draft, edit or submit.</p>}
        {pendingNoteCount > 0 && online && (canDraft || order) && (
          <p className="text-sm text-muted">Notes still waiting to sync are not included. Sync them first if the draft should use them.</p>
        )}
        {lockedReason && <p className="text-sm text-muted">{lockedReason}</p>}
        {order && <OrderFacts order={order} />}
        {error && (
          <p role="alert" className="text-sm font-medium text-danger">
            {error}
          </p>
        )}
        {message && (
          <p role="status" className="text-sm font-medium text-success">
            {message}
          </p>
        )}
        {phase === "loading" && !order && <p className="text-sm text-muted">Loading the work order…</p>}
        {phase === "error" && !order && online && (
          <button type="button" className={buttonSecondary} onClick={() => void load()}>
            Try again
          </button>
        )}
        {!order && phase !== "loading" && online && !cancelled && (
          <div className="space-y-3">
            <p className="text-sm text-muted">
              {canDraft
                ? "Draft a work order from the notes already on the server. You can edit it, then submit it for a dispatcher to approve."
                : pendingNoteCount > 0
                  ? "Sync your notes before drafting. The work order uses notes the server already has."
                  : "Add a note about the work before drafting a work order."}
            </p>
            <button type="button" className={buttonPrimary} disabled={!canDraft || pending !== null} onClick={onDraft}>
              {pending === "draft" ? "Drafting…" : "Draft with AI"}
            </button>
          </div>
        )}
        {order && editable && (
          <fieldset disabled={!online || pending !== null} className="min-w-0 space-y-4 border-0 p-0 disabled:opacity-60">
            <label className={`${labelClass} min-w-0`}>
              <span>Summary</span>
              <textarea value={form.summary} onChange={(event) => setForm((current) => ({ ...current, summary: event.target.value }))} maxLength={400} rows={3} className={inputClass} />
            </label>
            <div className="space-y-3">
              <h3 className="text-sm font-medium">Tasks</h3>
              {form.tasks.length === 0 && <p className="text-sm text-muted">No tasks.</p>}
              {form.tasks.map((task, index) => (
                <div key={task.key} className="grid min-w-0 gap-2 sm:grid-cols-[1fr_9rem_auto]">
                  <label className={`${labelClass} min-w-0`}>
                    <span>Task {index + 1}</span>
                    <input
                      value={task.description}
                      maxLength={200}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          tasks: current.tasks.map((item, i) => (i === index ? { ...item, description: event.target.value } : item)),
                        }))
                      }
                      className={inputClass}
                    />
                  </label>
                  <label className={labelClass}>
                    <span>State</span>
                    <select
                      value={task.state}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          tasks: current.tasks.map((item, i) => (i === index ? { ...item, state: event.target.value === "done" ? "done" : "to_do" } : item)),
                        }))
                      }
                      className={inputClass}
                    >
                      <option value="to_do">To do</option>
                      <option value="done">Done</option>
                    </select>
                  </label>
                  <button
                    type="button"
                    className={`${buttonSecondary} sm:self-end`}
                    onClick={() => setForm((current) => ({ ...current, tasks: current.tasks.filter((_, i) => i !== index) }))}
                  >
                    Remove task
                  </button>
                </div>
              ))}
              <button
                type="button"
                className={buttonSecondary}
                disabled={form.tasks.length >= 12}
                onClick={() => setForm((current) => ({ ...current, tasks: [...current.tasks, { key: crypto.randomUUID(), description: "", state: "to_do" }] }))}
              >
                Add task
              </button>
            </div>
            <div className="space-y-3">
              <h3 className="text-sm font-medium">Parts</h3>
              {form.lines.length === 0 && <p className="text-sm text-muted">No parts on this draft.</p>}
              {form.lines.map((line, index) => (
                <div key={line.key} className="min-w-0 space-y-2 rounded-card border border-border p-3">
                  <label className={`${labelClass} min-w-0`}>
                    <span>Part</span>
                    <input value={line.mentioned} maxLength={120} onChange={(event) => updateLine(index, { mentioned: event.target.value })} className={inputClass} />
                  </label>
                  <div className="grid min-w-0 gap-2 sm:grid-cols-3">
                    <label className={labelClass}>
                      <span>Quantity</span>
                      <input value={line.qty} inputMode="decimal" onChange={(event) => updateLine(index, { qty: event.target.value })} className={inputClass} />
                    </label>
                    <label className={labelClass}>
                      <span>Unit</span>
                      <select value={line.unit} onChange={(event) => updateLine(index, { unit: event.target.value })} className={inputClass}>
                        {units.map((unit) => (
                          <option key={unit} value={unit}>
                            {UNIT_LABEL[unit] ?? unit}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className={labelClass}>
                      <span>Used</span>
                      <select value={line.used} onChange={(event) => updateLine(index, { used: event.target.value === "needed" ? "needed" : "used" })} className={inputClass}>
                        <option value="used">Used</option>
                        <option value="needed">Needed</option>
                      </select>
                    </label>
                  </div>
                  <SkuField
                    value={line.sku}
                    disabled={!online || pending !== null}
                    online={online}
                    onChange={(sku) => updateLine(index, { sku })}
                    onPick={(part) => updateLine(index, { sku: part.sku, unit: part.unit, mentioned: line.mentioned.trim() ? line.mentioned : part.name })}
                  />
                  <FlagList flags={line.flags} />
                  <button type="button" className={buttonSecondary} onClick={() => setForm((current) => ({ ...current, lines: current.lines.filter((_, i) => i !== index) }))}>
                    Remove part
                  </button>
                </div>
              ))}
              <button
                type="button"
                className={buttonSecondary}
                disabled={form.lines.length >= 30}
                onClick={() =>
                  setForm((current) => ({
                    ...current,
                    lines: [...current.lines, { key: crypto.randomUUID(), sku: "", mentioned: "", qty: "1", unit: units[0] ?? "each", used: "used", flags: [] }],
                  }))
                }
              >
                Add part
              </button>
            </div>
            <label className={`${labelClass} min-w-0`}>
              <span>Follow-up</span>
              <textarea value={form.followUp} onChange={(event) => setForm((current) => ({ ...current, followUp: event.target.value }))} maxLength={300} rows={2} className={inputClass} />
            </label>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={buttonPrimary} disabled={!dirty} onClick={onSave}>
                {pending === "save" ? "Saving…" : "Save changes"}
              </button>
              <button type="button" className={buttonSecondary} disabled={dirty || order.summary.trim() === ""} onClick={onSubmit}>
                {pending === "submit" ? "Submitting…" : "Submit for approval"}
              </button>
              <button type="button" className={buttonSecondary} disabled={!canDraft} onClick={onDraft}>
                {pending === "draft" ? "Drafting…" : "Draft again"}
              </button>
            </div>
            <p className="text-sm text-muted">Draft again replaces this draft with a new one from the notes on the server.</p>
            {dirty && <p className="text-sm text-muted">Save changes before submitting.</p>}
            {!dirty && order.summary.trim() === "" && <p className="text-sm text-muted">Add a summary before submitting.</p>}
          </fieldset>
        )}
        {order && !editable && <ReadOnlyOrder order={order} />}
      </div>
    </Panel>
  );
}
