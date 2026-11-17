/** The loading state for a dispatcher page. Shown by `loading.tsx` while the server component runs. */
export function LoadingBlock({ section, label }: { section: string; label: string }) {
  return (
    <div aria-live="polite" aria-busy="true" className="space-y-3">
      <p className="text-sm font-semibold uppercase tracking-wide text-accent">Breakthru Ventures / {section}</p>
      <p className="text-lg text-muted">{label}</p>
    </div>
  );
}
