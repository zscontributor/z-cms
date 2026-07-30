/**
 * How a plugin's raw column value is read by a human — shared by the list table
 * and the detail screen.
 *
 * It lives on its own because those two screens must not disagree: a fee that
 * reads "1.200.000" in the list and "1200000.00" on the record it links to looks
 * like two different numbers, and the reader has no way to tell which is the one
 * the clinic will charge. One function, both screens.
 *
 * Nothing here knows a column's declared type. It cannot: the value arrives from
 * `SELECT *` over a table the platform did not design, so the shape of the string
 * is the only evidence available. That is why every branch is a recognition rather
 * than a conversion, and why anything unrecognised passes through untouched.
 */

/**
 * A plain number, grouped for the reader's locale: 55000 → "55,000" (en) or
 * "55.000" (vi). Integers go through BigInt so a large id or quantity keeps full
 * precision; a decimal keeps exactly the fraction digits it was stored with, so a
 * price is not silently rounded. Returns null for anything that is not a bare
 * number (a SKU, a slug, a uuid), which then passes through untouched.
 */
export function formatNumberLike(s: string, locale: string): string | null {
  if (/^-?\d+$/.test(s)) {
    try {
      return new Intl.NumberFormat(locale).format(BigInt(s));
    } catch {
      return null;
    }
  }
  if (/^-?\d+\.\d+$/.test(s)) {
    const decimals = Math.min(s.split(".")[1]!.length, 8);
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(Number(s));
  }
  return null;
}

/** A cell value from Postgres, made readable without knowing its column's type. */
export function formatCell(value: unknown, locale: string): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "✓" : "—";
  if (typeof value === "object") return JSON.stringify(value);
  const s = String(value);
  // An ISO timestamp reads better localized; anything else falls through.
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.toLocaleString(locale);
  }
  // A bare number gets thousands separators; a SKU/slug/uuid is left alone.
  return formatNumberLike(s, locale) ?? s;
}
