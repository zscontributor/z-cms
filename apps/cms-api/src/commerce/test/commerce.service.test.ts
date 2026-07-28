import { beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";

// The service reaches the database only through these three, so the whole store is
// a mock the tests drive directly — no Postgres, no RLS transaction.
const holder = vi.hoisted(() => ({ db: null as any, systemDb: null as any }));
vi.mock("@zcmsorg/database", () => ({
  db: () => holder.db,
  getSystemDb: () => holder.systemDb,
  withTenant: (_tid: string, fn: any) => fn(),
}));

import { CommerceService } from "../commerce.service";

const HOST = "shop.example";

function product(id: string, price: number | null, over: Record<string, unknown> = {}) {
  return {
    id,
    slug: `slug-${id}`,
    title: `Product ${id}`,
    data: price === null ? {} : { price },
    ...over,
  };
}

function makeDb(products: ReturnType<typeof product>[], settings: unknown = null) {
  const orders: any[] = [];
  return {
    _orders: orders,
    commerceSettings: { findFirst: vi.fn().mockResolvedValue(settings) },
    content: {
      findMany: vi.fn().mockImplementation(({ where }: any) => {
        const ids: string[] = where.id.in;
        return Promise.resolve(products.filter((p) => ids.includes(p.id)));
      }),
    },
    order: {
      count: vi.fn().mockImplementation(() => Promise.resolve(orders.length)),
      create: vi.fn().mockImplementation(({ data }: any) => {
        // Prisma returns the persisted row: nested `items.create` becomes an array,
        // and the timestamp columns are populated.
        const row = {
          id: `o${orders.length + 1}`,
          ...data,
          items: (data.items?.create ?? []).map((it: any, i: number) => ({ id: `oi${i}`, ...it })),
          placedAt: new Date("2026-01-01T00:00:00.000Z"),
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          paidAt: null,
        };
        orders.push(row);
        return Promise.resolve(row);
      }),
      findFirst: vi.fn().mockImplementation(({ where }: any) =>
        Promise.resolve(orders.find((o) => o.accessToken === where.accessToken || o.id === where.id) ?? null),
      ),
      update: vi.fn().mockImplementation(({ where, data }: any) => {
        const row = orders.find((o) => o.id === where.id);
        Object.assign(row, data);
        return Promise.resolve(row);
      }),
    },
  };
}

function publishedDomain() {
  return {
    domain: {
      findUnique: vi.fn().mockResolvedValue({
        hostname: HOST,
        site: { id: "s1", tenantId: "t1", status: "PUBLISHED", defaultLocale: "en" },
      }),
    },
  };
}

const customer = {
  name: "Ann Buyer",
  email: "ann@example.com",
  phone: "0900000000",
  address: "1 Rose Lane",
  city: "Hanoi",
};

describe("CommerceService.quote", () => {
  beforeEach(() => {
    holder.systemDb = publishedDomain();
  });

  it("prices a cart from the product's own data, ignoring anything the client could send", async () => {
    holder.db = makeDb([product("a", 48), product("b", 32)]);
    const service = new CommerceService({ registerCapabilityProjector() {} } as never);

    const quote = await service.quote(HOST, {
      items: [
        { productId: "a", quantity: 2 },
        { productId: "b", quantity: 1 },
      ],
    });

    expect(quote.subtotal).toBe(128); // 48*2 + 32
    expect(quote.total).toBe(128); // no shipping configured
    expect(quote.valid).toBe(true);
    expect(quote.items.every((line) => line.available)).toBe(true);
  });

  it("marks a missing or unpublished product unavailable and leaves it out of the total", async () => {
    holder.db = makeDb([product("a", 48)]);
    const service = new CommerceService({ registerCapabilityProjector() {} } as never);

    const quote = await service.quote(HOST, {
      items: [
        { productId: "a", quantity: 1 },
        { productId: "ghost", quantity: 5 },
      ],
    });

    expect(quote.subtotal).toBe(48);
    expect(quote.items.find((l) => l.productId === "ghost")?.available).toBe(false);
    expect(quote.valid).toBe(true);
  });

  it("charges a live salePrice and reports the discount off the list price", async () => {
    holder.db = makeDb([product("a", 100, { data: { price: 100, salePrice: 80 } })]);
    const service = new CommerceService({ registerCapabilityProjector() {} } as never);

    const quote = await service.quote(HOST, { items: [{ productId: "a", quantity: 2 }] });

    expect(quote.items[0]?.unitPrice).toBe(80);
    expect(quote.subtotal).toBe(160); // 80 * 2, the sale price
    expect(quote.discountTotal).toBe(40); // (100 - 80) * 2
    expect(quote.total).toBe(160);
  });

  it("ignores a salePrice whose window has already closed", async () => {
    holder.db = makeDb([
      product("a", 100, {
        data: { price: 100, salePrice: 80, saleEnd: "2020-01-01T00:00:00.000Z" },
      }),
    ]);
    const service = new CommerceService({ registerCapabilityProjector() {} } as never);

    const quote = await service.quote(HOST, { items: [{ productId: "a", quantity: 1 }] });

    expect(quote.items[0]?.unitPrice).toBe(100);
    expect(quote.subtotal).toBe(100);
    expect(quote.discountTotal).toBe(0);
  });

  it("ignores a salePrice that is not below the list price", async () => {
    holder.db = makeDb([product("a", 50, { data: { price: 50, salePrice: 60 } })]);
    const service = new CommerceService({ registerCapabilityProjector() {} } as never);

    const quote = await service.quote(HOST, { items: [{ productId: "a", quantity: 1 }] });

    expect(quote.items[0]?.unitPrice).toBe(50);
    expect(quote.discountTotal).toBe(0);
  });

  it("applies the flat shipping fee, then waives it above the free-shipping threshold", async () => {
    holder.db = makeDb([product("a", 20)], {
      enabled: true,
      currency: "USD",
      codEnabled: true,
      shippingFlatFee: 5,
      freeShippingThreshold: 100,
    });
    const service = new CommerceService({ registerCapabilityProjector() {} } as never);

    const small = await service.quote(HOST, { items: [{ productId: "a", quantity: 1 }] });
    expect(small.shippingFee).toBe(5);
    expect(small.total).toBe(25);

    const big = await service.quote(HOST, { items: [{ productId: "a", quantity: 6 }] });
    expect(big.subtotal).toBe(120);
    expect(big.shippingFee).toBe(0);
    expect(big.total).toBe(120);
  });
});

describe("CommerceService.createOrder", () => {
  beforeEach(() => {
    holder.systemDb = publishedDomain();
  });

  it("creates an order from server-computed totals and a snapshot of each line", async () => {
    holder.db = makeDb([product("a", 48)]);
    const service = new CommerceService({ registerCapabilityProjector() {} } as never);

    const result = await service.createOrder(HOST, {
      items: [{ productId: "a", quantity: 2 }],
      customer,
      paymentMethod: "COD",
    });

    expect(result.orderNumber).toBe("0001");
    expect(result.total).toBe(96);
    expect(result.accessToken).toBeTruthy();
    expect(result.status).toBe("PENDING");

    const created = holder.db.order.create.mock.calls[0][0].data;
    expect(created.total).toBe(96);
    expect(created.items.create[0]).toMatchObject({ productId: "a", unitPrice: 48, quantity: 2, lineTotal: 96 });
  });

  it("refuses to place an order whose only items are unavailable", async () => {
    holder.db = makeDb([]);
    const service = new CommerceService({ registerCapabilityProjector() {} } as never);

    await expect(
      service.createOrder(HOST, {
        items: [{ productId: "ghost", quantity: 1 }],
        customer,
        paymentMethod: "COD",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses checkout when the storefront is switched off", async () => {
    holder.db = makeDb([product("a", 48)], {
      enabled: false,
      currency: "USD",
      codEnabled: true,
      shippingFlatFee: 0,
      freeShippingThreshold: null,
    });
    const service = new CommerceService({ registerCapabilityProjector() {} } as never);

    await expect(
      service.createOrder(HOST, {
        items: [{ productId: "a", quantity: 1 }],
        customer,
        paymentMethod: "COD",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects a request for a site that is not published", async () => {
    holder.systemDb = { domain: { findUnique: vi.fn().mockResolvedValue(null) } };
    holder.db = makeDb([product("a", 48)]);
    const service = new CommerceService({ registerCapabilityProjector() {} } as never);

    await expect(
      service.quote(HOST, { items: [{ productId: "a", quantity: 1 }] }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("CommerceService.updateStatus", () => {
  beforeEach(() => {
    holder.systemDb = publishedDomain();
  });

  it("settles the COD payment and stamps paidAt when an order is fulfilled", async () => {
    holder.db = makeDb([product("a", 48)]);
    const service = new CommerceService({ registerCapabilityProjector() {} } as never);

    const placed = await service.createOrder(HOST, {
      items: [{ productId: "a", quantity: 1 }],
      customer,
      paymentMethod: "COD",
    });

    const updated = await service.updateStatus("s1", placed.id, "FULFILLED");
    expect(updated.status).toBe("FULFILLED");
    expect(updated.paymentStatus).toBe("PAID");
    expect(updated.paidAt).not.toBeNull();
  });
});
