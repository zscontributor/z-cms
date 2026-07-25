import { z } from "zod";

/**
 * The commerce contracts: what an anonymous shopper may POST, what the admin
 * configures, and the order shapes the API gives back.
 *
 * The load-bearing rule mirrors mail's: a client names a product and a quantity
 * and NOTHING ELSE about money. Prices, shipping and totals are absent from every
 * inbound schema below and are re-derived server-side from the product's own
 * `Content.data.price`. A cart edited in the browser can change what it asks for;
 * it cannot change what it costs.
 */

// ------------------------------------------------------------------ enums

export const ORDER_STATUSES = [
  "PENDING",
  "CONFIRMED",
  "FULFILLED",
  "CANCELLED",
  "REFUNDED",
] as const;
export const OrderStatusSchema = z.enum(ORDER_STATUSES);
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const PAYMENT_METHODS = ["COD"] as const;
export const PaymentMethodSchema = z.enum(PAYMENT_METHODS);
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_STATUSES = ["UNPAID", "PAID", "REFUNDED"] as const;
export const PaymentStatusSchema = z.enum(PAYMENT_STATUSES);
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

// ------------------------------------------------ public storefront input

/**
 * One cart line as the browser sends it. A product id and how many — the shop
 * supplies the price. `productId` is the Content id the theme rendered onto the
 * add-to-cart button.
 */
export const CartLineInputSchema = z.object({
  productId: z.uuid(),
  quantity: z.int().min(1).max(99),
});
export type CartLineInput = z.infer<typeof CartLineInputSchema>;

/** "How much is this cart?" — the check the drawer runs before checkout. */
export const QuoteRequestSchema = z.object({
  items: z.array(CartLineInputSchema).min(1).max(50),
});
export type QuoteRequest = z.infer<typeof QuoteRequestSchema>;

/** The delivery details a shopper types at checkout. */
export const CustomerInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.email().max(320),
  phone: z.string().trim().min(3).max(40),
  address: z.string().trim().min(1).max(500),
  city: z.string().trim().min(1).max(120),
});
export type CustomerInput = z.infer<typeof CustomerInputSchema>;

/** "Place this order." Everything money-shaped is recomputed on the server. */
export const CheckoutRequestSchema = z.object({
  items: z.array(CartLineInputSchema).min(1).max(50),
  customer: CustomerInputSchema,
  paymentMethod: PaymentMethodSchema.default("COD"),
  note: z.string().trim().max(1000).optional(),
  locale: z.string().max(20).optional(),
});
export type CheckoutRequest = z.infer<typeof CheckoutRequestSchema>;

// ------------------------------------------------------------ output DTOs

/** One priced line, as the server computed it. */
export interface QuoteLineDto {
  productId: string;
  slug: string;
  title: string;
  image: string | null;
  unitPrice: number;
  quantity: number;
  lineTotal: number;
  /** False when the product no longer exists or is unpublished — drop it. */
  available: boolean;
}

/** The full, authoritative price of a cart. */
export interface QuoteResultDto {
  currency: string;
  items: QuoteLineDto[];
  subtotal: number;
  shippingFee: number;
  discountTotal: number;
  total: number;
  /** Subtotal at or above which shipping is free. Null = never. */
  freeShippingThreshold: number | null;
  codEnabled: boolean;
  /** True when at least one line is available and checkout is possible. */
  valid: boolean;
}

export interface OrderItemDto {
  id: string;
  productId: string;
  productSlug: string;
  title: string;
  image: string | null;
  unitPrice: number;
  quantity: number;
  lineTotal: number;
}

export interface OrderDto {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  customer: {
    name: string;
    email: string;
    phone: string;
    address: string;
    city: string;
  };
  note: string | null;
  locale: string;
  currency: string;
  subtotal: number;
  shippingFee: number;
  discountTotal: number;
  total: number;
  items: OrderItemDto[];
  placedAt: string;
  paidAt: string | null;
  updatedAt: string;
}

/** The row the admin order list shows. No line items, no full address. */
export interface OrderSummaryDto {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  customerName: string;
  itemCount: number;
  currency: string;
  total: number;
  placedAt: string;
}

/**
 * What a completed checkout returns to the browser. `accessToken` is the shopper's
 * one credential for reading their own order back on the confirmation page — they
 * are anonymous, so nothing else authorises it.
 */
export interface CreateOrderResultDto {
  id: string;
  orderNumber: string;
  accessToken: string;
  status: OrderStatus;
  paymentMethod: PaymentMethod;
  currency: string;
  total: number;
}

// ---------------------------------------------------------- admin settings

/**
 * What the admin saves for the storefront. Money fields are major units in the
 * chosen currency. There are no secrets here — COD needs none — so unlike mail
 * settings the whole thing round-trips in the clear.
 */
export const CommerceSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  currency: z
    .string()
    .trim()
    .min(3)
    .max(3)
    .transform((value) => value.toUpperCase())
    .default("USD"),
  codEnabled: z.boolean().default(true),
  shippingFlatFee: z.number().min(0).max(1_000_000_000).default(0),
  freeShippingThreshold: z.number().min(0).max(1_000_000_000).nullable().default(null),
  storeName: z.string().trim().max(120).optional(),
  storeEmail: z.union([z.email().max(320), z.literal("")]).optional(),
});
export type CommerceSettingsInput = z.input<typeof CommerceSettingsSchema>;
export type CommerceSettings = z.output<typeof CommerceSettingsSchema>;

export interface CommerceSettingsDto {
  enabled: boolean;
  currency: string;
  codEnabled: boolean;
  shippingFlatFee: number;
  freeShippingThreshold: number | null;
  storeName: string | null;
  storeEmail: string | null;
}

/** The admin moving an order along. */
export const UpdateOrderStatusSchema = z.object({
  status: OrderStatusSchema,
});
export type UpdateOrderStatusInput = z.infer<typeof UpdateOrderStatusSchema>;

/**
 * The browser-safe storefront config the render projector exposes to the theme's
 * commerce slot. No prices (those are per-product content) and no secrets.
 */
export interface CommercePublicConfig {
  enabled: boolean;
  currency: string;
  codEnabled: boolean;
  shippingFlatFee: number;
  freeShippingThreshold: number | null;
}
