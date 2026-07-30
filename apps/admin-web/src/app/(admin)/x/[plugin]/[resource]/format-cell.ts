/**
 * How a plugin's raw column value is read by a human — shared by the list table
 * and the detail screen.
 *
 * It lives on its own because those two screens must not disagree: a fee that
 * reads "1.200.000" in the list and "1200000.00" on the record it links to looks
 * like two different numbers, and the reader has no way to tell which is the one
 * the clinic will charge. One function, both screens.
 *
 * It used to say that nothing here could know a column's declared type — that the
 * value arrives from `SELECT *` over a table the platform did not design, so the
 * shape of the string was the only evidence available. That was never true: the
 * plugin declares every column's type in `manifest.database.tables`, and the
 * server now sends those types along with the resource descriptor. The cost of
 * guessing was a phone number: `"0908999888"` is the exact shape of an integer, so
 * a `text` column was grouped like money and lost its leading zero — "908.999.888".
 *
 * So the type decides, and the shape is only the fallback for a value whose column
 * is unknown (a resource descriptor from an older server).
 */

/** The column types a plugin may declare, as they arrive on the descriptor. */
export type PluginColumnType =
  | "text"
  | "integer"
  | "bigint"
  | "boolean"
  | "numeric"
  | "timestamptz"
  | "uuid"
  | "jsonb";

/** The types that are quantities, and therefore the only ones grouped by locale. */
const NUMERIC: ReadonlySet<string> = new Set(["integer", "bigint", "numeric"]);

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

/** An ISO timestamp, localized. Null when the string is not one. */
function formatTimestamp(s: string, locale: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}[T ]/.test(s)) return null;
  const date = new Date(s);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString(locale);
}

/**
 * A cell value from Postgres, read as the column it came from.
 *
 * `type` is the plugin's own declaration. Pass it wherever the descriptor has it;
 * without it this falls back to recognising shapes, which is what it always did
 * and what it gets wrong for identifiers made of digits.
 */
export function formatCell(value: unknown, locale: string, type?: PluginColumnType): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "✓" : "—";
  if (typeof value === "object") return JSON.stringify(value);
  const s = String(value);

  if (type) {
    // A declared type answers the question outright — including by saying "no":
    // `text` and `uuid` are printed exactly as stored, whatever they look like.
    // This is the whole fix: a phone number is text, so it is left alone.
    if (type === "timestamptz") return formatTimestamp(s, locale) ?? s;
    if (NUMERIC.has(type)) return formatNumberLike(s, locale) ?? s;
    return s;
  }

  // No declared type: recognise, and pass anything unrecognised through.
  return formatTimestamp(s, locale) ?? formatNumberLike(s, locale) ?? s;
}
