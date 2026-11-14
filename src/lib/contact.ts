/** A `tel:` link, or null when the phone isn't a plain phone string. */
export function telHref(phone: string): string | null {
  const cleaned = phone.trim();
  if (!cleaned || !/^[0-9+().\-\s]+$/.test(cleaned)) return null;
  return `tel:${cleaned}`;
}

/** A `mailto:` link, or null when the address isn't a plain email. */
export function mailHref(email: string): string | null {
  const cleaned = email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) return null;
  return `mailto:${cleaned}`;
}
