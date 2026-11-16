import type { ReactNode } from "react";

export const wrapText = "min-w-0 break-words [overflow-wrap:anywhere]";

export function Fact({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`${wrapText} ${wide ? "sm:col-span-2" : ""}`}>
      <dt className="text-sm text-muted">{label}</dt>
      <dd className={wrapText}>{children}</dd>
    </div>
  );
}

export function FactList({ children }: { children: ReactNode }) {
  return <dl className="grid gap-4 sm:grid-cols-2">{children}</dl>;
}

/** The visible phone is what was stored. The `tel:` href keeps only digits and a leading plus. */
export function PhoneLink({ phone }: { phone: string }) {
  const href = phone.replace(/[^\d+]/g, "");
  if (href.length < 3) return <span className={wrapText}>{phone}</span>;
  return (
    <a href={`tel:${href}`} className={`${wrapText} text-accent hover:underline`}>
      {phone}
    </a>
  );
}

export function EmailLink({ email }: { email: string }) {
  return (
    <a href={`mailto:${encodeURIComponent(email)}`} className={`${wrapText} text-accent hover:underline`}>
      {email}
    </a>
  );
}
