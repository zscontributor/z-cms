import type { ContentStatus, OrderStatus, PaymentStatus } from "@zcmsorg/schemas";

/**
 * Formatters are cached per locale: constructing an Intl.DateTimeFormat is the
 * expensive part, and a list screen formats one date per row.
 */
const dateFormatters = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(locale: string): Intl.DateTimeFormat {
  let formatter = dateFormatters.get(locale);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    dateFormatters.set(locale, formatter);
  }
  return formatter;
}

export function formatDateTime(iso: string | null | undefined, locale: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return dateFormatter(locale).format(date);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

export type BadgeTone = "neutral" | "success" | "warning" | "info" | "danger";

export const STATUS_TONES: Record<ContentStatus, BadgeTone> = {
  DRAFT: "neutral",
  IN_REVIEW: "warning",
  SCHEDULED: "info",
  PUBLISHED: "success",
  ARCHIVED: "danger",
};

/** The label itself lives in the catalogue: `content.status.<STATUS>`. */
export function statusKey(status: ContentStatus): string {
  return `content.status.${status}`;
}

export const ORDER_STATUS_TONES: Record<OrderStatus, BadgeTone> = {
  PENDING: "warning",
  CONFIRMED: "info",
  FULFILLED: "success",
  CANCELLED: "danger",
  REFUNDED: "neutral",
};

export const PAYMENT_STATUS_TONES: Record<PaymentStatus, BadgeTone> = {
  UNPAID: "neutral",
  PAID: "success",
  REFUNDED: "warning",
};

/** Labels live in the catalogue: `commerce.orderStatus.<STATUS>`. */
export function orderStatusKey(status: OrderStatus): string {
  return `commerce.orderStatus.${status}`;
}

export function paymentStatusKey(status: PaymentStatus): string {
  return `commerce.paymentStatus.${status}`;
}

/** A money amount from an order, in the order's own currency. */
export function formatMoney(amount: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}
