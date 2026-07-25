import { beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestException } from "@nestjs/common";
import type { RequestActor } from "../../common/request-context";

// A theme's `theme.json` is untrusted input from a marketplace. These tests drive
// the demo-seed endpoint with a hostile manifest and assert on exactly what it would
// have written to the customer's database.
const holder = vi.hoisted(() => ({ db: null as any }));
vi.mock("@zcmsorg/database", () => ({
  db: () => holder.db,
  getSystemDb: () => holder.db,
}));

import { ThemesController } from "../themes.module";

const actor: RequestActor = {
  userId: "u1",
  tenantId: "t1",
  email: "a@x.com",
  role: "ADMIN",
  permissions: ["theme:configure"],
  siteId: "s1",
};

function demoContent(over: Record<string, unknown> = {}) {
  return {
    contentType: "page",
    slug: "home",
    locale: "en",
    title: "Home",
    blocks: [],
    ...over,
  };
}

function makeDb(demo: unknown, siteLocales: string[] = ["en"]) {
  return {
    site: {
      findUnique: vi.fn().mockResolvedValue({ locales: siteLocales }),
      update: vi.fn().mockResolvedValue({}),
    },
    siteTheme: {
      findFirst: vi.fn().mockResolvedValue({
        id: "st1",
        settings: {},
        theme: { key: "acme/theme" },
        version: { manifest: { demo } },
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    contentType: {
      upsert: vi.fn().mockResolvedValue({ id: "ct1" }),
    },
    content: {
      deleteMany: vi.fn().mockResolvedValue({}),
      create: (() => {
        let n = 0;
        return vi.fn().mockImplementation(() => Promise.resolve({ id: `c${++n}` }));
      })(),
    },
    menu: {
      deleteMany: vi.fn().mockResolvedValue({}),
      create: vi.fn().mockResolvedValue({ id: "m1" }),
    },
    menuItem: { create: vi.fn().mockResolvedValue({ id: "mi1" }) },
    commerceSettings: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "cs1" }),
      update: vi.fn().mockResolvedValue({ id: "cs1" }),
    },
    order: {
      deleteMany: vi.fn().mockResolvedValue({}),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue({ id: "o1" }),
    },
  };
}

const cache = { invalidateSite: vi.fn().mockResolvedValue(undefined) };
const audit = { record: vi.fn().mockResolvedValue(undefined) };

function makeController() {
  return new ThemesController(cache as any, audit as any);
}

/** Seeds a demo and returns the `blocks` the seed would have written for item 0. */
async function seedAndReadBlocks(blocks: unknown): Promise<any> {
  holder.db = makeDb({
    contentTypes: [{ key: "page", name: "Page", pluralName: "Pages" }],
    contents: [demoContent({ blocks })],
    menus: [],
  });
  await makeController().seedActiveDemo(actor, "s1");
  return holder.db.content.create.mock.calls[0][0].data.blocks;
}

const CONTENT_TYPES = [{ key: "page", name: "Page", pluralName: "Pages" }];

describe("ThemesController.seedActiveDemo", () => {
  beforeEach(() => {
    cache.invalidateSite.mockClear();
    audit.record.mockClear();
  });

  describe("sanitising a hostile theme manifest", () => {
    it("strips a <script> from demo block html", async () => {
      const written = await seedAndReadBlocks([
        {
          id: "b1",
          type: "core/richtext",
          props: { html: "<p>Welcome</p><script>alert(1)</script>" },
        },
      ]);

      expect(written[0].props.html).toBe("<p>Welcome</p>");
    });

    it("strips an onerror handler from demo block html", async () => {
      const written = await seedAndReadBlocks([
        {
          id: "b1",
          type: "core/richtext",
          props: { html: '<img src="/x.png" onerror="fetch(\'//evil.test\')">' },
        },
      ]);

      expect(written[0].props.html).not.toContain("onerror");
    });

    it("drops an <iframe> and a javascript: href from demo block html", async () => {
      const written = await seedAndReadBlocks([
        {
          id: "b1",
          type: "core/richtext",
          props: {
            html: '<iframe src="https://evil.test"></iframe><a href="javascript:alert(1)">x</a>',
          },
        },
      ]);

      expect(written[0].props.html).not.toContain("iframe");
      expect(written[0].props.html).not.toContain("javascript:");
    });

    it("sanitises html in a nested child block", async () => {
      const written = await seedAndReadBlocks([
        {
          id: "b1",
          type: "core/section",
          props: {},
          children: [
            {
              id: "b2",
              type: "core/richtext",
              props: { html: "<p>ok</p><script>alert(1)</script>" },
            },
          ],
        },
      ]);

      expect(written[0].children[0].props.html).toBe("<p>ok</p>");
    });

    it("leaves a legitimate demo page intact", async () => {
      // A theme's demo is its shop window. Sanitising must not wreck it.
      const html = '<h1>Welcome</h1><p>Read <a href="/about">about us</a>.</p>';
      const written = await seedAndReadBlocks([
        { id: "b1", type: "core/richtext", props: { html } },
      ]);

      expect(written[0].props.html).toBe(html);
    });
  });

  describe("block validation (the gate this path used to skip entirely)", () => {
    it("rejects a block tree nested deeper than the limit", async () => {
      // MAX_BLOCK_DEPTH is 32; build 40 levels of children.
      let node: any = { id: "leaf", type: "core/richtext", props: { html: "x" } };
      for (let i = 0; i < 40; i++) {
        node = { id: `n${i}`, type: "core/section", props: {}, children: [node] };
      }

      holder.db = makeDb({
        contentTypes: CONTENT_TYPES,
        contents: [demoContent({ blocks: [node] })],
        menus: [],
      });

      await expect(makeController().seedActiveDemo(actor, "s1")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("rejects a malformed block (no id, bad type)", async () => {
      holder.db = makeDb({
        contentTypes: CONTENT_TYPES,
        contents: [demoContent({ blocks: [{ type: "not-namespaced", props: {} }] })],
        menus: [],
      });

      await expect(makeController().seedActiveDemo(actor, "s1")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("writes nothing at all when one item's blocks are invalid", async () => {
      // Validation runs up front, so a bad item does not leave the earlier ones
      // behind it in the database — and does not delete the site's existing rows.
      holder.db = makeDb({
        contentTypes: CONTENT_TYPES,
        contents: [
          demoContent({ slug: "a" }),
          demoContent({ slug: "b", blocks: [{ type: "bad", props: {} }] }),
        ],
        menus: [],
      });

      await expect(makeController().seedActiveDemo(actor, "s1")).rejects.toThrow(
        BadRequestException,
      );
      expect(holder.db.content.create).not.toHaveBeenCalled();
      expect(holder.db.content.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe("size caps", () => {
    it("rejects a demo with more than 200 contents", async () => {
      const contents = Array.from({ length: 201 }, (_, i) =>
        demoContent({ slug: `p${i}` }),
      );
      holder.db = makeDb({ contentTypes: CONTENT_TYPES, contents, menus: [] });

      await expect(makeController().seedActiveDemo(actor, "s1")).rejects.toThrow(
        /201 contents; the limit is 200/,
      );
      expect(holder.db.content.create).not.toHaveBeenCalled();
    });

    it("rejects a demo with more than 20 content types", async () => {
      const contentTypes = Array.from({ length: 21 }, (_, i) => ({
        key: `t${i}`,
        name: `T${i}`,
        pluralName: `T${i}s`,
      }));
      holder.db = makeDb({ contentTypes, contents: [], menus: [] });

      await expect(makeController().seedActiveDemo(actor, "s1")).rejects.toThrow(
        /21 content types; the limit is 20/,
      );
    });

    it("rejects a demo with more than 20 menus", async () => {
      const menus = Array.from({ length: 21 }, (_, i) => ({
        key: `m${i}`,
        name: `M${i}`,
        items: [],
      }));
      holder.db = makeDb({ contentTypes: CONTENT_TYPES, contents: [], menus });

      await expect(makeController().seedActiveDemo(actor, "s1")).rejects.toThrow(
        /21 menus; the limit is 20/,
      );
    });

    it("accepts a demo at the limit", async () => {
      const contents = Array.from({ length: 200 }, (_, i) =>
        demoContent({ slug: `p${i}` }),
      );
      holder.db = makeDb({ contentTypes: CONTENT_TYPES, contents, menus: [] });

      const res = await makeController().seedActiveDemo(actor, "s1");

      expect(res.ok).toBe(true);
      expect(holder.db.content.create).toHaveBeenCalledTimes(200);
    });

    it("does not delete the site's existing demo rows before rejecting an oversized demo", async () => {
      const contents = Array.from({ length: 500 }, (_, i) =>
        demoContent({ slug: `p${i}` }),
      );
      holder.db = makeDb({ contentTypes: CONTENT_TYPES, contents, menus: [] });

      await expect(makeController().seedActiveDemo(actor, "s1")).rejects.toThrow(
        BadRequestException,
      );
      expect(holder.db.content.deleteMany).not.toHaveBeenCalled();
      expect(holder.db.menu.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe("commerce demo", () => {
    const productTypes = [
      { key: "page", name: "Page", pluralName: "Pages" },
      { key: "product", name: "Product", pluralName: "Products" },
    ];
    const products = [
      demoContent({ contentType: "product", slug: "serum", title: "Serum", data: { price: 48 } }),
      demoContent({ contentType: "product", slug: "balm", title: "Balm", data: { price: 24 } }),
    ];

    it("seeds storefront settings and prices sample orders from the seeded products", async () => {
      holder.db = makeDb({
        contentTypes: productTypes,
        contents: products,
        menus: [],
        commerce: { currency: "USD", shippingFlatFee: 5, freeShippingThreshold: 50 },
        orders: [
          {
            customer: { name: "Ann", email: "a@x.com", phone: "1", address: "1 St", city: "Hanoi" },
            items: [{ slug: "serum", quantity: 1 }],
            status: "FULFILLED",
          },
          {
            customer: { name: "Bo", email: "b@x.com", phone: "2", address: "2 St", city: "Hue" },
            items: [{ slug: "serum", quantity: 1 }, { slug: "balm", quantity: 1 }],
            status: "PENDING",
          },
        ],
      });

      const res = await makeController().seedActiveDemo(actor, "s1");
      expect(res.orders).toBe(2);

      // The settings were written…
      expect(holder.db.commerceSettings.create).toHaveBeenCalledTimes(1);

      // …one order under the free-shipping threshold pays the flat fee (48 + 5)…
      const first = holder.db.order.create.mock.calls[0][0].data;
      expect(first.subtotal).toBe(48);
      expect(first.shippingFee).toBe(5);
      expect(first.total).toBe(53);
      expect(first.status).toBe("FULFILLED");
      expect(first.paymentStatus).toBe("PAID");
      expect(first.demoThemeKey).toBe("acme/theme");

      // …and one over the threshold ships free (48 + 24 = 72 ≥ 50).
      const second = holder.db.order.create.mock.calls[1][0].data;
      expect(second.subtotal).toBe(72);
      expect(second.shippingFee).toBe(0);
      expect(second.total).toBe(72);
    });

    it("removes previously-seeded demo orders before writing new ones", async () => {
      holder.db = makeDb({ contentTypes: productTypes, contents: products, menus: [] });
      await makeController().seedActiveDemo(actor, "s1");
      expect(holder.db.order.deleteMany).toHaveBeenCalledWith({
        where: { siteId: "s1", demoThemeKey: "acme/theme" },
      });
    });

    it("skips a demo order line whose product was not seeded rather than inventing a price", async () => {
      holder.db = makeDb({
        contentTypes: productTypes,
        contents: products,
        menus: [],
        orders: [
          {
            customer: { name: "Ann", email: "a@x.com", phone: "1", address: "1 St", city: "Hanoi" },
            items: [{ slug: "ghost", quantity: 1 }],
          },
        ],
      });
      const res = await makeController().seedActiveDemo(actor, "s1");
      expect(res.orders).toBe(0);
      expect(holder.db.order.create).not.toHaveBeenCalled();
    });
  });

  describe("locale enabling", () => {
    // The switcher (ctx.alternates) only surfaces a locale the site enables, so a
    // multilingual demo has to enable the locales it just published in.
    const trilingual = [
      demoContent({ locale: "en", slug: "home", translationGroup: "home" }),
      demoContent({ locale: "vi", slug: "trang-chu", translationGroup: "home" }),
      demoContent({ locale: "ja", slug: "home-ja", translationGroup: "home" }),
    ];

    it("adds the demo's locales to a site that does not publish them yet", async () => {
      holder.db = makeDb(
        { contentTypes: CONTENT_TYPES, contents: trilingual, menus: [] },
        ["en"],
      );
      await makeController().seedActiveDemo(actor, "s1");
      expect(holder.db.site.update).toHaveBeenCalledWith({
        where: { id: "s1" },
        data: { locales: ["en", "vi", "ja"] },
      });
    });

    it("keeps the site's existing locales and order, appending only new ones", async () => {
      holder.db = makeDb(
        { contentTypes: CONTENT_TYPES, contents: trilingual, menus: [] },
        ["vi", "en"],
      );
      await makeController().seedActiveDemo(actor, "s1");
      expect(holder.db.site.update).toHaveBeenCalledWith({
        where: { id: "s1" },
        data: { locales: ["vi", "en", "ja"] },
      });
    });

    it("does not write Site.locales when the demo adds no new locale", async () => {
      holder.db = makeDb(
        { contentTypes: CONTENT_TYPES, contents: trilingual, menus: [] },
        ["en", "vi", "ja"],
      );
      await makeController().seedActiveDemo(actor, "s1");
      expect(holder.db.site.update).not.toHaveBeenCalled();
    });
  });
});
