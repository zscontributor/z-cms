import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { db, getSystemDb, withTenant } from "@zcmsorg/database";
import type {
  CheckoutRequest,
  CommercePublicConfig,
  CommerceSettings,
  CommerceSettingsDto,
  CreateOrderResultDto,
  OrderDto,
  OrderStatus,
  OrderSummaryDto,
  Paginated,
  QuoteLineDto,
  QuoteRequest,
  QuoteResultDto,
} from "@zcmsorg/schemas";
import { PluginsService } from "../plugins/plugins.service";
import { COMMERCE_PLUGIN_KEY } from "./commerce-plugin";

/**
 * The storefront's server half.
 *
 * One rule runs through all of it: money is the shop's word, never the client's.
 * The browser sends a product id and a quantity; every price, line total, shipping
 * fee and grand total below is recomputed here from the product's own
 * `Content.data.price`, read PUBLISHED-only from this site's catalogue. A cart
 * doctored in the browser can change what it asks for; it cannot change what it
 * costs, and `createOrder` re-runs the same computation rather than trusting a
 * quote the client might have kept.
 */

/** The site a public request resolved to, cross-tenant. */
interface ResolvedSite {
  tenantId: string;
  siteId: string;
  locale: string;
}

/** Defaults for a site that has never opened the commerce settings screen. */
const DEFAULTS: CommerceSettingsDto = {
  enabled: true,
  currency: "USD",
  codEnabled: true,
  shippingFlatFee: 0,
  freeShippingThreshold: null,
  storeName: null,
  storeEmail: null,
};

function money(value: number): number {
  // Two decimals, and never -0. Prices are small; this keeps float artefacts
  // ("48.410000000000004") out of an order total.
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function readPrice(data: unknown): number | null {
  if (!data || typeof data !== "object") return null;
  const raw = (data as Record<string, unknown>).price;
  const parsed = typeof raw === "string" ? Number(raw) : raw;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function readImage(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const raw = (data as Record<string, unknown>).image;
  return typeof raw === "string" && raw ? raw : null;
}

@Injectable()
export class CommerceService implements OnModuleInit {
  constructor(private readonly plugins: PluginsService) {}

  /**
   * Registers commerce as a render projector — the same extension point the AI
   * assistant uses. Now `provider.kind: "plugin"`: the storefront contributes only
   * where the commerce plugin is ACTIVE, so switching commerce off on a site takes
   * its checkout off that site's pages, in one mechanism with everything else the
   * plugin gates. `resolve` still narrows further — the theme must opt in and the
   * shop must be enabled — but eligibility is now the plugin's activation, not a
   * core special case.
   */
  onModuleInit(): void {
    this.plugins.registerCapabilityProjector("commerce.checkout", {
      provider: { kind: "plugin", pluginKey: COMMERCE_PLUGIN_KEY },
      resolve: ({ siteId, themeCapabilities }) =>
        this.publicConfig(siteId, themeCapabilities),
    });
  }

  /**
   * The browser-safe storefront config, or null when the shop is not live here —
   * the theme did not opt in, or the operator switched checkout off. Uses the
   * system client with an explicit site id, because the render path that calls it
   * carries no tenant context.
   */
  async publicConfig(
    siteId: string,
    themeCapabilities: readonly string[],
  ): Promise<CommercePublicConfig | null> {
    // A theme that cannot render a storefront should not be handed one.
    if (!themeCapabilities.includes("commerce.checkout")) return null;

    const row = await getSystemDb().commerceSettings.findFirst({ where: { siteId } });
    // No row means never configured, which defaults to on — a shop with a commerce
    // theme works the day it is installed. An explicit `enabled: false` is the
    // operator taking checkout down, and it wins.
    if (row && !row.enabled) return null;

    return {
      enabled: true,
      currency: row?.currency ?? "USD",
      codEnabled: row?.codEnabled ?? true,
      shippingFlatFee: row ? Number(row.shippingFlatFee) : 0,
      freeShippingThreshold:
        row?.freeShippingThreshold != null ? Number(row.freeShippingThreshold) : null,
    };
  }

  // ------------------------------------------------------------- public flow

  /**
   * Resolve the site behind a public request from its hostname. Cross-tenant, so
   * it uses the system client — the request carries no session and no tenant.
   */
  private async resolveSite(hostname: string): Promise<ResolvedSite> {
    const domain = await getSystemDb().domain.findUnique({
      where: { hostname: hostname.toLowerCase() },
      include: { site: true },
    });
    if (!domain || domain.site.status !== "PUBLISHED") {
      throw new NotFoundException("Site not found.");
    }
    return {
      tenantId: domain.site.tenantId,
      siteId: domain.site.id,
      locale: domain.site.defaultLocale,
    };
  }

  /** "How much is this cart?" — the check the drawer runs before checkout. */
  async quote(hostname: string, request: QuoteRequest): Promise<QuoteResultDto> {
    const site = await this.resolveSite(hostname);
    return withTenant(site.tenantId, () => this.computeQuote(site.siteId, request.items));
  }

  /**
   * Price a cart authoritatively. Every line is looked up PUBLISHED-only in this
   * site's catalogue; a line whose product is gone or unpublished comes back
   * `available: false` and is left out of the totals.
   */
  private async computeQuote(
    siteId: string,
    items: { productId: string; quantity: number }[],
  ): Promise<QuoteResultDto> {
    const settings = await this.readSettings(siteId);

    // Collapse duplicate ids the client may have sent as separate lines.
    const wanted = new Map<string, number>();
    for (const item of items) {
      wanted.set(item.productId, (wanted.get(item.productId) ?? 0) + item.quantity);
    }

    const rows = await db().content.findMany({
      where: { siteId, id: { in: [...wanted.keys()] }, status: "PUBLISHED" },
      select: { id: true, slug: true, title: true, data: true },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));

    const lines: QuoteLineDto[] = [];
    for (const [productId, quantity] of wanted) {
      const row = byId.get(productId);
      const price = row ? readPrice(row.data) : null;
      if (!row || price === null) {
        lines.push({
          productId,
          slug: row?.slug ?? "",
          title: row?.title ?? "",
          image: null,
          unitPrice: 0,
          quantity,
          lineTotal: 0,
          available: false,
        });
        continue;
      }
      lines.push({
        productId,
        slug: row.slug,
        title: row.title,
        image: readImage(row.data),
        unitPrice: money(price),
        quantity,
        lineTotal: money(price * quantity),
        available: true,
      });
    }

    const available = lines.filter((line) => line.available);
    const subtotal = money(available.reduce((sum, line) => sum + line.lineTotal, 0));
    const freeShip =
      settings.freeShippingThreshold !== null && subtotal >= settings.freeShippingThreshold;
    const shippingFee = available.length && !freeShip ? money(settings.shippingFlatFee) : 0;
    const total = money(subtotal + shippingFee);

    return {
      currency: settings.currency,
      items: lines,
      subtotal,
      shippingFee,
      discountTotal: 0,
      total,
      freeShippingThreshold: settings.freeShippingThreshold,
      codEnabled: settings.codEnabled,
      valid: settings.enabled && available.length > 0,
    };
  }

  /** Place an order. The quote is recomputed here, never taken from the client. */
  async createOrder(hostname: string, request: CheckoutRequest): Promise<CreateOrderResultDto> {
    const site = await this.resolveSite(hostname);

    return withTenant(site.tenantId, async () => {
      const settings = await this.readSettings(site.siteId);
      if (!settings.enabled) {
        throw new BadRequestException("This shop is not accepting orders right now.");
      }
      if (request.paymentMethod === "COD" && !settings.codEnabled) {
        throw new BadRequestException("Cash on delivery is not available.");
      }

      const quote = await this.computeQuote(site.siteId, request.items);
      const available = quote.items.filter((line) => line.available);
      if (!quote.valid || available.length === 0) {
        throw new BadRequestException(
          "None of the items in your cart are available. Refresh and try again.",
        );
      }

      const locale = request.locale ?? site.locale;
      const created = await this.insertOrder(site, request, quote, available, locale);

      return {
        id: created.id,
        orderNumber: created.orderNumber,
        accessToken: created.accessToken,
        status: created.status as OrderStatus,
        paymentMethod: "COD",
        currency: quote.currency,
        total: quote.total,
      };
    });
  }

  /**
   * Write the order and its lines. The order number is sequential per site, which
   * two simultaneous checkouts can collide on; the unique index is the real guard
   * and this retries a few times around it rather than serialising every order.
   */
  private async insertOrder(
    site: ResolvedSite,
    request: CheckoutRequest,
    quote: QuoteResultDto,
    lines: QuoteLineDto[],
    locale: string,
  ) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const count = await db().order.count({ where: { siteId: site.siteId } });
      const orderNumber = String(count + 1 + attempt).padStart(4, "0");
      const accessToken = randomBytes(24).toString("base64url");

      try {
        return await db().order.create({
          data: {
            tenantId: site.tenantId,
            siteId: site.siteId,
            orderNumber,
            accessToken,
            status: "PENDING",
            paymentMethod: "COD",
            paymentStatus: "UNPAID",
            customerName: request.customer.name,
            customerEmail: request.customer.email,
            customerPhone: request.customer.phone,
            shippingAddress: request.customer.address,
            shippingCity: request.customer.city,
            note: request.note ?? null,
            locale,
            currency: quote.currency,
            subtotal: quote.subtotal,
            shippingFee: quote.shippingFee,
            discountTotal: quote.discountTotal,
            total: quote.total,
            items: {
              create: lines.map((line) => ({
                tenantId: site.tenantId,
                siteId: site.siteId,
                productId: line.productId,
                productSlug: line.slug,
                title: line.title,
                image: line.image,
                unitPrice: line.unitPrice,
                quantity: line.quantity,
                lineTotal: line.lineTotal,
              })),
            },
          },
        });
      } catch (error) {
        // A clash on (siteId, orderNumber): recount and try the next number.
        if (isUniqueViolation(error) && attempt < 4) continue;
        throw error;
      }
    }
    throw new ConflictException("Could not allocate an order number. Please try again.");
  }

  /** The confirmation page's read: one order, by the token minted at checkout. */
  async getOrderByToken(hostname: string, accessToken: string): Promise<OrderDto> {
    const site = await this.resolveSite(hostname);
    return withTenant(site.tenantId, async () => {
      const order = await db().order.findFirst({
        where: { siteId: site.siteId, accessToken },
        include: { items: true },
      });
      if (!order) throw new NotFoundException("Order not found.");
      return toOrderDto(order);
    });
  }

  // -------------------------------------------------------------- admin flow

  async listOrders(
    siteId: string,
    query: { status?: OrderStatus; search?: string; page: number; perPage: number },
  ): Promise<Paginated<OrderSummaryDto>> {
    const where = {
      siteId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              { orderNumber: { contains: query.search, mode: "insensitive" as const } },
              { customerName: { contains: query.search, mode: "insensitive" as const } },
              { customerEmail: { contains: query.search, mode: "insensitive" as const } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      db().order.findMany({
        where,
        orderBy: { placedAt: "desc" },
        skip: (query.page - 1) * query.perPage,
        take: query.perPage,
        include: { _count: { select: { items: true } } },
      }),
      db().order.count({ where }),
    ]);

    return {
      items: rows.map(
        (row): OrderSummaryDto => ({
          id: row.id,
          orderNumber: row.orderNumber,
          status: row.status as OrderStatus,
          paymentMethod: "COD",
          paymentStatus: row.paymentStatus as OrderDto["paymentStatus"],
          customerName: row.customerName,
          itemCount: row._count.items,
          currency: row.currency,
          total: Number(row.total),
          placedAt: row.placedAt.toISOString(),
        }),
      ),
      page: query.page,
      perPage: query.perPage,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.perPage)),
    };
  }

  async getOrder(siteId: string, id: string): Promise<OrderDto> {
    const order = await db().order.findFirst({
      where: { id, siteId },
      include: { items: true },
    });
    if (!order) throw new NotFoundException("Order not found.");
    return toOrderDto(order);
  }

  /**
   * Move an order along. The state machine is deliberately liberal — a small shop
   * corrects mistakes by hand — but two transitions carry a side effect: reaching
   * FULFILLED settles a COD payment, and REFUNDED marks it refunded.
   */
  async updateStatus(siteId: string, id: string, status: OrderStatus): Promise<OrderDto> {
    const order = await db().order.findFirst({ where: { id, siteId } });
    if (!order) throw new NotFoundException("Order not found.");

    const paymentStatus =
      status === "FULFILLED"
        ? "PAID"
        : status === "REFUNDED"
          ? "REFUNDED"
          : order.paymentStatus;
    const paidAt =
      status === "FULFILLED" && !order.paidAt ? new Date() : order.paidAt;

    await db().order.update({
      where: { id: order.id },
      data: { status, paymentStatus, paidAt },
    });
    return this.getOrder(siteId, id);
  }

  // --------------------------------------------------------------- settings

  /** Settings as the DTO the admin screen renders; defaults when unconfigured. */
  async readSettingsDto(siteId: string): Promise<CommerceSettingsDto> {
    return this.readSettings(siteId);
  }

  private async readSettings(siteId: string): Promise<CommerceSettingsDto> {
    const row = await db().commerceSettings.findFirst({ where: { siteId } });
    if (!row) return DEFAULTS;
    return {
      enabled: row.enabled,
      currency: row.currency,
      codEnabled: row.codEnabled,
      shippingFlatFee: Number(row.shippingFlatFee),
      freeShippingThreshold:
        row.freeShippingThreshold === null ? null : Number(row.freeShippingThreshold),
      storeName: row.storeName,
      storeEmail: row.storeEmail,
    };
  }

  async saveSettings(
    tenantId: string,
    siteId: string,
    input: CommerceSettings,
  ): Promise<CommerceSettingsDto> {
    const existing = await db().commerceSettings.findFirst({ where: { siteId } });
    const data = {
      enabled: input.enabled,
      currency: input.currency,
      codEnabled: input.codEnabled,
      shippingFlatFee: input.shippingFlatFee,
      freeShippingThreshold: input.freeShippingThreshold,
      storeName: input.storeName?.trim() || null,
      storeEmail: input.storeEmail?.trim().toLowerCase() || null,
    };

    if (existing) {
      await db().commerceSettings.update({ where: { id: existing.id }, data });
    } else {
      await db().commerceSettings.create({ data: { tenantId, siteId, ...data } });
    }
    return this.readSettings(siteId);
  }
}

// --------------------------------------------------------------------- helpers

type OrderRow = {
  id: string;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  shippingAddress: string;
  shippingCity: string;
  note: string | null;
  locale: string;
  currency: string;
  subtotal: unknown;
  shippingFee: unknown;
  discountTotal: unknown;
  total: unknown;
  placedAt: Date;
  paidAt: Date | null;
  updatedAt: Date;
  items: {
    id: string;
    productId: string;
    productSlug: string;
    title: string;
    image: string | null;
    unitPrice: unknown;
    quantity: number;
    lineTotal: unknown;
  }[];
};

function toOrderDto(order: OrderRow): OrderDto {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status as OrderStatus,
    paymentMethod: "COD",
    paymentStatus: order.paymentStatus as OrderDto["paymentStatus"],
    customer: {
      name: order.customerName,
      email: order.customerEmail,
      phone: order.customerPhone,
      address: order.shippingAddress,
      city: order.shippingCity,
    },
    note: order.note,
    locale: order.locale,
    currency: order.currency,
    subtotal: Number(order.subtotal),
    shippingFee: Number(order.shippingFee),
    discountTotal: Number(order.discountTotal),
    total: Number(order.total),
    items: order.items.map((item) => ({
      id: item.id,
      productId: item.productId,
      productSlug: item.productSlug,
      title: item.title,
      image: item.image,
      unitPrice: Number(item.unitPrice),
      quantity: item.quantity,
      lineTotal: Number(item.lineTotal),
    })),
    placedAt: order.placedAt.toISOString(),
    paidAt: order.paidAt?.toISOString() ?? null,
    updatedAt: order.updatedAt.toISOString(),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "P2002"
  );
}
