import { ConflictException, NotFoundException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const site = {
  create: vi.fn(),
  update: vi.fn(),
  findUnique: vi.fn(),
  findUniqueOrThrow: vi.fn(),
  findMany: vi.fn(),
};
const domain = {
  create: vi.fn(),
  update: vi.fn(),
  deleteMany: vi.fn(),
  updateMany: vi.fn(),
};
const contentType = { create: vi.fn() };
const content = { create: vi.fn() };

const installCorePlugins = vi.fn().mockResolvedValue([]);
vi.mock("@zcmsorg/database", () => ({
  db: () => ({ site, domain, contentType, content }),
  installCorePlugins: (...args: unknown[]) => installCorePlugins(...args),
}));

import { SitesController } from "../sites.module";
import { CreateSiteSchema } from "../../openapi/registry";
import type { RequestActor } from "../../common/request-context";

const cache = {
  forgetHosts: vi.fn().mockResolvedValue(undefined),
  invalidateSite: vi.fn().mockResolvedValue(undefined),
};

const queue = { enqueue: vi.fn().mockResolvedValue(undefined) };
const audit = { record: vi.fn().mockResolvedValue(undefined) };

function controller() {
  return new SitesController(cache as never, queue as never, audit as never);
}

const actor: RequestActor = {
  userId: "u1",
  tenantId: "t1",
  email: "a@x.com",
  role: "OWNER",
  permissions: [],
  siteId: "s1",
};

/** A row as Prisma would hand it back, with the includes the controller asks for. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "s1",
    tenantId: "t1",
    slug: "acme",
    name: "Acme",
    status: "DRAFT",
    defaultLocale: "vi",
    locales: ["vi"],
    settings: {},
    domains: [{ id: "d1", hostname: "acme.test", isPrimary: true }],
    themes: [],
    ...overrides,
  };
}

/** What Prisma throws on a unique violation. */
function uniqueViolation(target: string[]) {
  return Object.assign(new Error("Unique constraint failed"), {
    code: "P2002",
    meta: { target },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  site.create.mockResolvedValue({ id: "s1" });
  site.findUniqueOrThrow.mockResolvedValue(row());
  domain.create.mockResolvedValue({ id: "d1" });
  domain.update.mockResolvedValue({ id: "d1" });
  domain.deleteMany.mockResolvedValue({ count: 0 });
  domain.updateMany.mockResolvedValue({ count: 1 });
  contentType.create.mockResolvedValue({ id: "ct1" });
  content.create.mockResolvedValue({ id: "c1" });
});

describe("create", () => {
  it("puts the built-in plugins on the new site, for the site the token names", async () => {
    // zAI is part of what z-cms IS, so a new site should not have to go hunting for
    // it in a catalogue. What it must NOT do is come up quietly running a plugin that
    // holds `network:fetch` — so installCorePlugins installs it switched OFF with
    // nothing granted, and the consent screen appears when someone flips the switch.
    // (That INACTIVE/nothing-granted contract is asserted in the database package,
    // where the function lives; here we assert only that site creation performs it.)
    await controller().create(actor, {
      name: "Acme",
      slug: "acme",
      hostnames: ["acme.test"],
      defaultLocale: "vi",
    } as never);

    expect(installCorePlugins).toHaveBeenCalledWith(
      expect.anything(),
      "t1", // from the actor's token, never from the body
      "s1",
    );
  });

  it("creates the site AND its domain — a site with no domain answers nothing", async () => {
    // site-runtime resolves a site from the Host header and nothing else. A create
    // that made only the site row would hand back something no visitor can reach.
    await controller().create(actor, {
      name: "Acme",
      slug: "acme",
      hostnames: ["acme.test"],
      defaultLocale: "vi",
    } as never);

    expect(site.create).toHaveBeenCalledTimes(1);
    expect(domain.create).toHaveBeenCalledWith({
      data: { tenantId: "t1", siteId: "s1", hostname: "acme.test", isPrimary: true },
    });
  });

  it("creates one Domain row per hostname — the first primary, the rest aliases", async () => {
    // "z-soft.com.vn" and "z-soft.vn" are the same site. Both must become rows, or
    // the second address resolves to nothing; only the first is the primary the
    // others redirect to.
    await controller().create(actor, {
      name: "Z-SOFT",
      slug: "z-soft",
      hostnames: ["z-soft.com.vn", "z-soft.vn"],
      defaultLocale: "vi",
    } as never);

    expect(domain.create).toHaveBeenCalledTimes(2);
    expect(domain.create).toHaveBeenNthCalledWith(1, {
      data: { tenantId: "t1", siteId: "s1", hostname: "z-soft.com.vn", isPrimary: true },
    });
    expect(domain.create).toHaveBeenNthCalledWith(2, {
      data: { tenantId: "t1", siteId: "s1", hostname: "z-soft.vn", isPrimary: false },
    });
  });

  it("seeds a `page` type and a published homepage — or the site 404s on /", async () => {
    // The regression this exists for: a site that had a domain, a theme and a
    // PUBLISHED status, and still answered 404 on "/", because the homepage is the
    // content row whose slug is the empty string and nothing had created one. The
    // owner could not fix it from the admin either: with no content type there is
    // nothing to file a page under.
    await controller().create(actor, {
      name: "Acme",
      slug: "acme",
      hostnames: ["acme.test"],
      defaultLocale: "vi",
    } as never);

    const type = contentType.create.mock.calls[0][0].data;
    expect(type).toMatchObject({ siteId: "s1", key: "page", routePrefix: "" });

    const page = content.create.mock.calls[0][0].data;
    expect(page).toMatchObject({
      siteId: "s1",
      contentTypeId: "ct1",
      // The empty slug IS the homepage.
      slug: "",
      // The site's own default locale, not a hardcoded one — a homepage in a
      // language the site does not publish is a 404 with extra steps.
      locale: "vi",
      // Published on purpose: a draft homepage leaves "/" as empty as before.
      status: "PUBLISHED",
    });
    expect(page.blocks[0].props.heading).toBe("Hello, welcome to z-cms!");
  });

  it("seeds the homepage in the site's default locale, not a hardcoded one", async () => {
    await controller().create(actor, {
      name: "Acme",
      slug: "acme",
      hostnames: ["acme.test"],
      defaultLocale: "en",
    } as never);

    expect(content.create.mock.calls[0][0].data.locale).toBe("en");
  });

  it("creates a DRAFT by default — an unconfigured site should not be serving", async () => {
    await controller().create(actor, {
      name: "Acme",
      slug: "acme",
      hostnames: ["acme.test"],
      defaultLocale: "vi",
      publish: false,
    } as never);

    expect(site.create.mock.calls[0][0].data.status).toBe("DRAFT");
  });

  it("publishes on create when asked, rather than in a second call that can fail", async () => {
    // A create-then-PATCH can fail halfway and leave a site that exists, is
    // unreachable, and that nobody was told to go and publish.
    await controller().create(actor, {
      name: "Acme",
      slug: "acme",
      hostnames: ["acme.test"],
      defaultLocale: "vi",
      publish: true,
    } as never);

    expect(site.create.mock.calls[0][0].data.status).toBe("PUBLISHED");
  });

  it("stores the brand under settings.brand", async () => {
    await controller().create(actor, {
      name: "Acme",
      slug: "acme",
      hostnames: ["acme.test"],
      defaultLocale: "vi",
      brand: { primaryColor: "#112233", logo: "/uploads/l.png" },
    } as never);

    expect(site.create.mock.calls[0][0].data.settings).toEqual({
      brand: { primaryColor: "#112233", logo: "/uploads/l.png" },
    });
  });

  it("gives a site created with no brand the platform's default", async () => {
    // So that a theme reading ctx.site.brand.primaryColor on the very first render
    // gets a colour rather than an empty string.
    await controller().create(actor, {
      name: "Acme",
      slug: "acme",
      hostnames: ["acme.test"],
      defaultLocale: "vi",
    } as never);

    const brand = site.create.mock.calls[0][0].data.settings.brand;
    expect(brand.primaryColor).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it("forces the default locale into the site's locales", async () => {
    // Otherwise every URL on the site resolves to a language the site does not have.
    await controller().create(actor, {
      name: "Acme",
      slug: "acme",
      hostnames: ["acme.test"],
      defaultLocale: "vi",
      locales: ["en"],
    } as never);

    expect(site.create.mock.calls[0][0].data.locales).toEqual(["vi", "en"]);
  });

  it("defaults a new site to the platform's three languages when none are named", async () => {
    // A trilingual site out of the box is what lets the default theme's language
    // switcher exist at all: on a single-locale site it renders nothing.
    await controller().create(actor, {
      name: "Acme",
      slug: "acme",
      hostnames: ["acme.test"],
      defaultLocale: "vi",
    } as never);

    expect(site.create.mock.calls[0][0].data.locales).toEqual(["vi", "en", "ja"]);
  });

  it("keeps a caller's own default locale alongside the three when it is a fourth", async () => {
    await controller().create(actor, {
      name: "Acme",
      slug: "acme",
      hostnames: ["acme.test"],
      defaultLocale: "fr",
    } as never);

    expect(site.create.mock.calls[0][0].data.locales).toEqual(["fr", "vi", "en", "ja"]);
  });

  it("turns a hostname collision into a 409 that does not say whose site it is", async () => {
    // A hostname is unique across the whole PLATFORM, so the clash may be with a
    // tenant the caller cannot see. Confirming that would leak its existence.
    site.create.mockRejectedValueOnce(uniqueViolation(["hostname"]));

    await expect(
      controller().create(actor, {
        name: "Acme",
        slug: "acme",
        hostnames: ["taken.test"],
        defaultLocale: "vi",
      } as never),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("turns a slug collision into a 409 too, and tells them apart", async () => {
    site.create.mockRejectedValueOnce(uniqueViolation(["tenant_id", "slug"]));

    const error = await controller()
      .create(actor, {
        name: "Acme",
        slug: "acme",
        hostnames: ["fresh.test"],
        defaultLocale: "vi",
      } as never)
      .catch((err: Error) => err);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as Error).message).not.toBe("");
  });

  it("does not swallow an error that is not a unique violation", async () => {
    // A dropped connection must not be reported to the user as "name taken".
    site.create.mockRejectedValueOnce(new Error("connection reset"));

    await expect(
      controller().create(actor, {
        name: "Acme",
        slug: "acme",
        hostnames: ["acme.test"],
        defaultLocale: "vi",
      } as never),
    ).rejects.toThrow("connection reset");
  });
});

describe("update", () => {
  it("merges the brand into settings without dropping other keys", async () => {
    // `settings` is shared. A brand save that replaced it wholesale would silently
    // delete whatever another feature had stored beside it.
    site.findUnique.mockResolvedValue(
      row({ settings: { brand: { primaryColor: "#000000", logo: "" }, somethingElse: 42 } }),
    );
    site.update.mockResolvedValue(row());

    await controller().update("s1", {
      brand: { primaryColor: "#FFFFFF", logo: "/new.png" },
    } as never);

    expect(site.update.mock.calls[0][0].data.settings).toEqual({
      brand: { primaryColor: "#FFFFFF", logo: "/new.png" },
      somethingElse: 42,
    });
  });

  it("touches only the fields that were sent", async () => {
    site.findUnique.mockResolvedValue(row());
    site.update.mockResolvedValue(row());

    await controller().update("s1", { name: "Renamed" } as never);

    const data = site.update.mock.calls[0][0].data;
    expect(data).toEqual({ name: "Renamed" });
    expect(data).not.toHaveProperty("settings");
    expect(data).not.toHaveProperty("status");
  });

  it("replaces the hostname from the edit-site form — old one removed, new one added", async () => {
    // The list REPLACES the site's domains. Renaming the only hostname drops the old
    // row and inserts the new one; the new one is the primary.
    site.findUnique.mockResolvedValueOnce(row());
    site.findUniqueOrThrow.mockResolvedValueOnce(
      row({
        slug: "renamed",
        domains: [{ id: "d2", hostname: "renamed.test", isPrimary: true }],
      }),
    );
    site.update.mockResolvedValue(row({ slug: "renamed" }));

    await controller().update("s1", {
      slug: "renamed",
      hostnames: ["renamed.test"],
    } as never);

    expect(site.update.mock.calls[0][0].data).toMatchObject({ slug: "renamed" });
    // acme.test (d1) is no longer in the list, so it goes.
    expect(domain.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["d1"] } } });
    // renamed.test is new, so it is inserted.
    expect(domain.create).toHaveBeenCalledWith({
      data: { tenantId: "t1", siteId: "s1", hostname: "renamed.test", isPrimary: false },
    });
    // Exactly one primary, set to the first of the list.
    expect(domain.updateMany).toHaveBeenNthCalledWith(1, {
      where: { siteId: "s1" },
      data: { isPrimary: false },
    });
    expect(domain.updateMany).toHaveBeenNthCalledWith(2, {
      where: { siteId: "s1", hostname: "renamed.test" },
      data: { isPrimary: true },
    });
  });

  it("adds an alias without touching the existing primary's row", async () => {
    // Existing site answers on acme.test (d1, primary). The operator adds a second
    // domain: acme.test stays as-is, only the new alias is inserted.
    site.findUnique.mockResolvedValueOnce(row());
    site.findUniqueOrThrow.mockResolvedValueOnce(
      row({
        domains: [
          { id: "d1", hostname: "acme.test", isPrimary: true },
          { id: "d3", hostname: "acme.vn", isPrimary: false },
        ],
      }),
    );
    site.update.mockResolvedValue(row());

    await controller().update("s1", {
      hostnames: ["acme.test", "acme.vn"],
    } as never);

    // Nothing removed: both desired hosts are wanted.
    expect(domain.deleteMany).not.toHaveBeenCalled();
    // Only the new alias is created; acme.test already exists on this site.
    expect(domain.create).toHaveBeenCalledTimes(1);
    expect(domain.create).toHaveBeenCalledWith({
      data: { tenantId: "t1", siteId: "s1", hostname: "acme.vn", isPrimary: false },
    });
    // The primary stays the first entry.
    expect(domain.updateMany).toHaveBeenNthCalledWith(2, {
      where: { siteId: "s1", hostname: "acme.test" },
      data: { isPrimary: true },
    });
  });

  it("drops the hostname cache as well as the render cache", async () => {
    // The host lookup holds the site's name and brand for ten minutes and is NOT
    // keyed by the render cache version. Bumping only the version leaves an owner
    // staring at their old logo with no way to hurry it along.
    site.findUnique.mockResolvedValue(row());
    site.update.mockResolvedValue(row());

    await controller().update("s1", {
      brand: { primaryColor: "#FFFFFF", logo: "" },
    } as never);

    expect(cache.forgetHosts).toHaveBeenCalledWith(["acme.test"]);
    expect(cache.invalidateSite).toHaveBeenCalledWith("s1");
  });

  it("refuses to leave the default locale outside the site's locales", async () => {
    // Checked against the RESULT of the patch: dropping a locale the default points
    // at is the same broken site whether the default moved in this request or not.
    site.findUnique.mockResolvedValue(row({ defaultLocale: "vi", locales: ["vi", "en"] }));

    await expect(
      controller().update("s1", { locales: ["en"] } as never),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(site.update).not.toHaveBeenCalled();
  });

  it("404s on a site that is not yours — the same answer as one that does not exist", async () => {
    site.findUnique.mockResolvedValue(null);

    await expect(
      controller().update("nope", { name: "x" } as never),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("CreateSiteSchema hostnames", () => {
  // The field is described to people as the address of their site, so they paste
  // the thing in their address bar. The resolver matches the Host header, which
  // has no scheme and no path — so accept the URL and reduce it, don't reject it.
  it("accepts a pasted URL and stores the bare hostname", () => {
    const parsed = CreateSiteSchema.parse({
      name: "Z-CMS",
      slug: "z-cms",
      hostnames: "https://z-cms.org/",
      defaultLocale: "vi",
    });

    expect(parsed.hostnames).toEqual(["z-cms.org"]);
  });

  it("splits a comma-separated list into several hostnames, primary first", () => {
    // The one domain field lets an operator enter both spellings of a site at once.
    const parsed = CreateSiteSchema.parse({
      name: "Z-SOFT",
      slug: "z-soft",
      hostnames: "z-soft.com.vn, z-soft.vn",
    });

    expect(parsed.hostnames).toEqual(["z-soft.com.vn", "z-soft.vn"]);
  });

  it("de-duplicates the same host typed twice", () => {
    expect(
      CreateSiteSchema.parse({ name: "a", slug: "a", hostnames: "z-cms.org, z-cms.org" }).hostnames,
    ).toEqual(["z-cms.org"]);
  });

  it("also accepts an array, and a host with a port", () => {
    expect(CreateSiteSchema.parse({ name: "a", slug: "a", hostnames: ["z-cms.org"] }).hostnames).toEqual(
      ["z-cms.org"],
    );
    expect(
      CreateSiteSchema.parse({ name: "a", slug: "a", hostnames: "localhost:3100" }).hostnames,
    ).toEqual(["localhost:3100"]);
  });

  it("defaults publish to false, so the safe thing happens when nobody asked", () => {
    expect(CreateSiteSchema.parse({ name: "a", slug: "a", hostnames: "z-cms.org" }).publish).toBe(
      false,
    );
  });

  it("requires at least one hostname", () => {
    expect(CreateSiteSchema.safeParse({ name: "a", slug: "a", hostnames: "" }).success).toBe(false);
    expect(CreateSiteSchema.safeParse({ name: "a", slug: "a", hostnames: [] }).success).toBe(false);
  });

  it("rejects something that is not an address at all", () => {
    expect(
      CreateSiteSchema.safeParse({ name: "a", slug: "a", hostnames: "not a host" }).success,
    ).toBe(false);
  });
});

describe("rebuildSitemap", () => {
  it("enqueues a site.sitemap job for the caller's tenant and the site in the URL", async () => {
    site.findUnique.mockResolvedValue({ id: "s1" });

    const result = await controller().rebuildSitemap(actor, "s1");

    expect(result).toEqual({ status: "queued" });
    expect(queue.enqueue).toHaveBeenCalledWith("site.sitemap", {
      tenantId: "t1",
      siteId: "s1",
    });
  });

  it("enqueues WITHOUT a jobId, so a manual rebuild always runs and never dedupes away", async () => {
    // A stable jobId collapses into the hour-retained completed job — a second click
    // would silently do nothing. The manual trigger must pass no options at all.
    site.findUnique.mockResolvedValue({ id: "s1" });

    await controller().rebuildSitemap(actor, "s1");

    const [, , options] = queue.enqueue.mock.calls[0]!;
    expect(options).toBeUndefined();
  });

  it("records an audit entry naming the site", async () => {
    site.findUnique.mockResolvedValue({ id: "s1" });

    await controller().rebuildSitemap(actor, "s1");

    expect(audit.record).toHaveBeenCalledWith(actor, "site.sitemap.rebuilt", "site", "s1");
  });

  it("404s an unknown site and enqueues nothing", async () => {
    // RLS makes a foreign site indistinguishable from a missing one — both are 404,
    // and neither may cause a rebuild to be queued.
    site.findUnique.mockResolvedValue(null);

    await expect(controller().rebuildSitemap(actor, "nope")).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});
