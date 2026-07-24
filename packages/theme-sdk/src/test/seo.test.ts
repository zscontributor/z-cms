import { DEFAULT_SITE_BRAND } from "@zcmsorg/schemas";
import type { ContentDto, RenderPayload } from "@zcmsorg/schemas";
import { describe, expect, it, vi } from "vitest";
import { resolveAssetUrl } from "../asset";
import { organizationJsonLd, resolveSeo } from "../seo";
import type { Theme, ThemeContext, ThemeSeoDefaults } from "../types";

/**
 * The document head is the one place where content an untrusted author typed,
 * settings an admin typed, and values a plugin filtered all meet — and it is
 * rendered on a public page, for everybody. So the tests here are as much about
 * WHOSE value wins as about what the value is: a page must never be able to
 * index itself back into a staging site, and a plugin's filtered SEO must never
 * be able to smuggle markup out of a <meta> tag.
 */

function theme(overrides: {
  manifestSeo?: ThemeSeoDefaults;
  seo?: (ctx: ThemeContext<Record<string, unknown>>) => ThemeSeoDefaults;
}): Theme {
  return {
    manifest: {
      id: "vn.zsoft.theme.default",
      name: "Default",
      version: "1.0.0",
      author: { name: "Z-SOFT" },
      engine: ">=0.1.0",
      templates: ["page"],
      menuLocations: [],
      settingsSchema: { type: "object", properties: {} },
      ...(overrides.manifestSeo ? { seo: overrides.manifestSeo } : {}),
    },
    Layout: () => null,
    templates: { page: () => null },
    blocks: {},
    ...(overrides.seo ? { seo: overrides.seo } : {}),
  };
}

function context(site?: Partial<RenderPayload["site"]>): ThemeContext {
  return {
    site: {
      id: "site_1",
      name: "Acme",
      canonicalHost: "acme.test",
      locale: "en",
      defaultLocale: "en",
      locales: ["en"],
      brand: DEFAULT_SITE_BRAND,
      ...site,
    },
    settings: {},
    menus: {},
    locale: "en",
    t: (key) => key,
    renderBlocks: () => null,
    hasCapability: () => false,
    getIntegration: () => undefined,
    renderSlot: () => null,
    collections: {},
    url: (path) => path,
    // The real one, against a stand-in base: these tests care that icons are put
    // through it at all, which a pass-through stub would not catch.
    asset: (path) => resolveAssetUrl("/theme-assets/theme/1.0.0/", path),
    alternates: [],
    colorMode: {
      modes: ["light", "dark"],
      default: "system",
      toggleable: true,
      attribute: "data-theme",
    },
  };
}

/** A published page, with only the fields `resolveSeo` reads set meaningfully. */
function content(overrides: Partial<ContentDto> = {}): ContentDto {
  return {
    id: "c_1",
    siteId: "site_1",
    contentType: { id: "ct_1", key: "page", name: "Page" },
    locale: "en",
    translationGroupId: "tg_1",
    title: "Pricing",
    slug: "pricing",
    path: "/pricing",
    excerpt: null,
    data: {},
    blocks: [],
    seo: {},
    status: "PUBLISHED",
    publishedAt: null,
    author: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as ContentDto;
}

const NO_PAGE = { content: null, archive: null } as const;

describe("resolveSeo", () => {
  it("titles a page with its own title, composed through the theme's template", () => {
    const t = theme({ manifestSeo: { titleTemplate: "%s — %site%", defaultTitle: "Acme" } });

    const seo = resolveSeo(t, context(), { content: content(), archive: null });

    expect(seo.title).toBe("Pricing — Acme");
  });

  it("falls back to the site name when the page has no title of its own", () => {
    // The homepage. Without this the <title> would be empty, which is the single
    // most visible SEO defect a CMS can ship.
    const t = theme({ manifestSeo: { titleTemplate: "%s — Acme", defaultTitle: "Acme Inc" } });

    const seo = resolveSeo(t, context(), NO_PAGE);

    expect(seo.title).toBe("Acme Inc");
  });

  it("uses the site's own name when neither the theme nor the site declares a default title", () => {
    const seo = resolveSeo(theme({}), context({ name: "Bakery" }), NO_PAGE);

    expect(seo.title).toBe("Bakery");
  });

  it("leaves the title untouched when the theme ships no template", () => {
    const seo = resolveSeo(theme({}), context(), { content: content(), archive: null });

    expect(seo.title).toBe("Pricing");
  });

  it("titles an archive route from the archive's own title", () => {
    const archive = {
      contentTypeKey: "post",
      title: "Blog",
      basePath: "/blog",
      items: [],
      page: 1,
      totalPages: 1,
    };

    const seo = resolveSeo(theme({}), context(), { content: null, archive });

    expect(seo.title).toBe("Blog");
  });

  it("prefers the page's SEO title over the page's display title", () => {
    // `content.seo` is what a plugin filtered; it is the most specific source and
    // must win, or an SEO plugin cannot do its job.
    const page = content({ title: "Pricing", seo: { title: "Plans and pricing" } });

    const seo = resolveSeo(theme({}), context(), { content: page, archive: null });

    expect(seo.title).toBe("Plans and pricing");
  });

  it("lets a value the theme derives from site settings beat the value it shipped with", () => {
    // The whole point of `Theme.seo(ctx)`: an admin editing "Site title" in the
    // theme's settings form changes the head without a theme release.
    const t = theme({
      manifestSeo: { defaultTitle: "Shipped default", description: "Shipped description" },
      seo: () => ({ defaultTitle: "This site", description: "This site's description" }),
    });

    const seo = resolveSeo(t, context(), NO_PAGE);

    expect(seo.title).toBe("This site");
    expect(seo.description).toBe("This site's description");
  });

  it("passes the theme context to Theme.seo so it can read the site's settings", () => {
    const derive = vi.fn(() => ({ defaultTitle: "Derived" }));
    const ctx = context();

    resolveSeo(theme({ seo: derive }), ctx, NO_PAGE);

    expect(derive).toHaveBeenCalledWith(ctx);
  });

  it("describes a page with its excerpt when neither the page nor the theme sets a description", () => {
    const page = content({ excerpt: "Everything we charge for." });

    const seo = resolveSeo(theme({}), context(), { content: page, archive: null });

    expect(seo.description).toBe("Everything we charge for.");
  });

  it("returns no description at all when no source has one", () => {
    // `undefined`, not "": the runtime omits the tag entirely, and an empty
    // description tag is worse for search engines than an absent one.
    const seo = resolveSeo(theme({}), context(), NO_PAGE);

    expect(seo.description).toBeUndefined();
  });

  it("indexes and follows by default", () => {
    const seo = resolveSeo(theme({}), context(), NO_PAGE);

    expect(seo.robots).toEqual({ index: true, follow: true });
  });

  it("lets a single page opt out of indexing", () => {
    const page = content({ seo: { noindex: true } });

    const seo = resolveSeo(theme({}), context(), { content: page, archive: null });

    expect(seo.robots).toEqual({ index: false, follow: false });
  });

  it("refuses to let a page opt back IN to indexing on a site the theme has closed", () => {
    // The staging kill switch. `robots: { index: false }` in the theme is what
    // keeps a staging site out of Google; if any page could override it, one
    // page with `noindex: false` would leak the whole staging site into search.
    const t = theme({ manifestSeo: { robots: { index: false, follow: false } } });
    const page = content({ seo: { noindex: false } });

    const seo = resolveSeo(t, context(), { content: page, archive: null });

    expect(seo.robots).toEqual({ index: false, follow: false });
  });

  it("marks a post as an article and everything else as a website", () => {
    // og:type drives how the link renders on social; a page announced as an
    // article without a published time is a broken card.
    const post = content({ contentType: { id: "ct_2", key: "post", name: "Post" } });

    expect(resolveSeo(theme({}), context(), { content: post, archive: null }).ogType).toBe(
      "article",
    );
    expect(resolveSeo(theme({}), context(), NO_PAGE).ogType).toBe("website");
  });

  it("carries the page's canonical URL through when it declares one", () => {
    const page = content({ seo: { canonical: "https://acme.test/plans" } });

    const seo = resolveSeo(theme({}), context(), { content: page, archive: null });

    expect(seo.canonical).toBe("https://acme.test/plans");
  });

  it("emits no canonical URL when the page declares none", () => {
    // resolveSeo does NOT synthesise a canonical from the path: an invented one
    // that disagrees with the served URL de-indexes the page.
    const seo = resolveSeo(theme({}), context(), { content: content(), archive: null });

    expect(seo.canonical).toBeUndefined();
  });

  it("takes the social image from the page, then the site, then the theme", () => {
    const t = theme({ manifestSeo: { ogImage: "/shipped.png" }, seo: () => ({ ogImage: "/site.png" }) });

    expect(resolveSeo(t, context(), NO_PAGE).ogImage).toBe("/site.png");
    expect(
      resolveSeo(t, context(), {
        content: content({ seo: { ogImage: "/page.png" } }),
        archive: null,
      }).ogImage,
    ).toBe("/page.png");
  });

  it("merges icons field by field so a site overriding one does not lose the others", () => {
    // A site that sets only a favicon must keep the theme's apple-touch icon.
    const t = theme({
      manifestSeo: { icons: { favicon: "/shipped.ico", appleTouchIcon: "/apple.png" } },
      seo: () => ({ icons: { favicon: "/site.ico" } }),
    });

    const seo = resolveSeo(t, context(), NO_PAGE);

    expect(seo.icons).toEqual({ favicon: "/site.ico", appleTouchIcon: "/apple.png" });
  });

  it("resolves the icons a theme ships against that theme's own assets", () => {
    // The reason a favicon belongs to the theme and not to the runtime: the theme
    // names a file inside its own package, and it lands under its own base. A
    // second theme naming "assets/favicon.ico" gets a different URL, so the two
    // cannot serve each other's icon.
    const t = theme({
      manifestSeo: {
        icons: { favicon: "assets/favicon.ico", icon: "assets/icon.png" },
      },
    });

    const seo = resolveSeo(t, context(), NO_PAGE);

    expect(seo.icons.favicon).toBe("/theme-assets/theme/1.0.0/assets/favicon.ico");
    expect(seo.icons.icon).toBe("/theme-assets/theme/1.0.0/assets/icon.png");
  });

  it("lets an uploaded favicon override the shipped one without being rewritten", () => {
    const t = theme({
      manifestSeo: { icons: { favicon: "assets/favicon.ico" } },
      // What themes/default does with its `favicon` setting.
      seo: () => ({ icons: { favicon: "/uploads/site.ico" } }),
    });

    const seo = resolveSeo(t, context(), NO_PAGE);

    // Absolute already: rewriting it under the theme's bundle would 404.
    expect(seo.icons.favicon).toBe("/uploads/site.ico");
  });

  it("does not treat themeColor as a path", () => {
    const t = theme({ manifestSeo: { icons: { themeColor: "#FA5600" } } });

    const seo = resolveSeo(t, context(), NO_PAGE);

    expect(seo.icons.themeColor).toBe("#FA5600");
  });

  it("merges the organisation field by field, including its address", () => {
    // Same reason: overriding the logo must not silently delete the publisher's
    // postal address from the JSON-LD, which search engines read as a signal.
    const t = theme({
      manifestSeo: {
        organization: {
          name: "Z-SOFT",
          logo: "/shipped-logo.png",
          address: { street: "1 Main St", country: "VN" },
        },
      },
      seo: () => ({ organization: { name: "Acme", address: { street: "2 Side St" } } }),
    });

    const seo = resolveSeo(t, context(), NO_PAGE);

    expect(seo.organization).toEqual({
      name: "Acme",
      logo: "/shipped-logo.png",
      address: { street: "2 Side St", country: "VN" },
    });
  });

  it("has no organisation when neither the theme nor the site declares one", () => {
    expect(resolveSeo(theme({}), context(), NO_PAGE).organization).toBeUndefined();
  });

  it("reports the locale this page was rendered in, not the site's default", () => {
    // hreflang and og:locale are per-URL. Reporting the default here would tell
    // Google every Vietnamese page is English.
    const seo = resolveSeo(theme({}), context({ locale: "vi", defaultLocale: "en" }), NO_PAGE);

    expect(seo.locale).toBe("vi");
  });

  it("exposes the published time of a page and nothing for one that has none", () => {
    const published = content({ publishedAt: "2026-03-01T10:00:00.000Z" });

    expect(
      resolveSeo(theme({}), context(), { content: published, archive: null }).publishedTime,
    ).toBe("2026-03-01T10:00:00.000Z");
    expect(
      resolveSeo(theme({}), context(), { content: content(), archive: null }).publishedTime,
    ).toBeUndefined();
  });

  it("returns hostile page titles verbatim — escaping is the renderer's job, not this function's", () => {
    // ATTACK: a stored-XSS attempt through a post title. An author with only
    // `content:create` types a title that closes the meta tag it will land in.
    //
    // resolveSeo is a *data* function: it hands the runtime a plain object, and
    // the runtime (Next's Metadata, which HTML-escapes attribute values, and the
    // JSON-LD writer, which escapes "<") is where the string becomes markup.
    // This test pins that contract down: the value must arrive UNMANGLED and
    // UNESCAPED, because a function that half-escaped here would double-escape
    // in the head ("&amp;lt;") and, worse, would tempt a theme into believing the
    // string is already safe to interpolate into raw HTML. If this test ever
    // starts failing, the escaping boundary has moved and every consumer of
    // ResolvedSeo has to be re-audited.
    const attack = '"><script>alert(1)</script>';
    const page = content({ title: attack, excerpt: attack, seo: { canonical: attack } });

    const seo = resolveSeo(theme({}), context(), { content: page, archive: null });

    expect(seo.title).toBe(attack);
    expect(seo.description).toBe(attack);
    expect(seo.canonical).toBe(attack);
  });

  it("expands $-patterns in an author's title into the theme's title template (KNOWN DEFECT)", () => {
    // ATTACK: `applyTemplate` calls `template.replace("%s", title)` with the
    // AUTHOR'S TITLE as the replacement string, and `String.replace` treats "$&",
    // "$`" and "$'" in a replacement as references to the match and the text
    // around it. So an author who titles a post "$`" splices the part of the
    // template BEFORE the slot into the rendered <title>, and can push the site
    // name around in it. No XSS (Next escapes the head), but the title of a page
    // is attacker-influenced output and must not be a template engine.
    //
    // This test pins the CURRENT behaviour so the defect is visible and cannot
    // regress unnoticed. Fixing it (splitting on "%s" instead of `replace`, or
    // escaping "$" in the replacement) SHOULD break this test — that is the point.
    const t = theme({ manifestSeo: { titleTemplate: "PREFIX %s SUFFIX" } });
    const page = content({ title: "$`$'$&" });

    const seo = resolveSeo(t, context(), { content: page, archive: null });

    expect(seo.title).toBe("PREFIX PREFIX  SUFFIX%s SUFFIX");
  });

  it("expands a %site% typed by an author and starves the template's real slot (KNOWN DEFECT)", () => {
    // ATTACK: `applyTemplate` runs `.replace("%s", title).replace("%site%", siteName)`.
    // `String.replace(string, …)` substitutes only the FIRST occurrence, so when
    // the author's title itself contains "%site%", THAT copy is consumed by the
    // replacement and the template's own "%site%" is left as raw text. The author
    // both injects the site name where they want it AND breaks the theme's real
    // one. Attacker-controlled template expansion in the public <title>. Pinned so
    // the defect is visible; a proper fix (literal, single-shot substitution)
    // should change this output.
    const t = theme({ manifestSeo: { titleTemplate: "%s — %site%", defaultTitle: "Acme" } });
    const page = content({ title: "Read about %site%" });

    const seo = resolveSeo(t, context(), { content: page, archive: null });

    expect(seo.title).toBe("Read about Acme — %site%");
  });
});

describe("organizationJsonLd", () => {
  it("builds schema.org Organization JSON-LD from the theme's organisation", () => {
    const ld = organizationJsonLd({
      name: "Z-SOFT",
      url: "https://z-cms.org",
      logo: "https://z-cms.org/logo.png",
    });

    expect(ld).toEqual({
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "Z-SOFT",
      url: "https://z-cms.org",
      logo: "https://z-cms.org/logo.png",
    });
  });

  it("returns nothing when there is no organisation to describe", () => {
    // No <script type="application/ld+json"> at all is correct; an empty one is
    // a structured-data error in Search Console.
    expect(organizationJsonLd(undefined)).toBeNull();
  });

  it("returns nothing for an organisation with no name", () => {
    // `name` is required by schema.org. Emitting the node without it publishes
    // an invalid entity rather than none.
    expect(organizationJsonLd({ name: "" })).toBeNull();
  });

  it("drops fields the theme left empty rather than emitting them blank", () => {
    const ld = organizationJsonLd({ name: "Z-SOFT", legalName: "", email: undefined });

    expect(ld).not.toHaveProperty("legalName");
    expect(ld).not.toHaveProperty("email");
    expect(ld).not.toHaveProperty("url");
  });

  it("omits the address entirely when every one of its fields is empty", () => {
    const ld = organizationJsonLd({
      name: "Z-SOFT",
      address: { street: "", locality: "", country: "" },
    });

    expect(ld).not.toHaveProperty("address");
  });

  it("emits a PostalAddress as soon as one address field is filled in", () => {
    const ld = organizationJsonLd({ name: "Z-SOFT", address: { locality: "Da Nang" } });

    expect(ld?.address).toEqual({ "@type": "PostalAddress", addressLocality: "Da Nang" });
  });

  it("omits sameAs when the theme lists no profiles", () => {
    // An empty `sameAs: []` claims "this entity is nowhere else", which is worse
    // than saying nothing.
    const ld = organizationJsonLd({ name: "Z-SOFT", sameAs: [] });

    expect(ld).not.toHaveProperty("sameAs");
  });

  it("keeps the profiles a theme does list", () => {
    const ld = organizationJsonLd({ name: "Z-SOFT", sameAs: ["https://github.com/z-soft"] });

    expect(ld?.sameAs).toEqual(["https://github.com/z-soft"]);
  });

  it("returns a plain object, so a hostile value cannot become markup here", () => {
    // ATTACK: an admin (or a compromised theme setting) puts "</script>" in the
    // organisation name. This function must NOT produce a string — it returns
    // data, and the runtime is what serialises it and escapes "<" as <. If
    // this ever returned pre-rendered HTML, that escape would be bypassed.
    const ld = organizationJsonLd({ name: '</script><script>alert(1)</script>' });

    expect(typeof ld).toBe("object");
    expect(ld?.name).toBe('</script><script>alert(1)</script>');
    // And the serialisation the runtime performs must be able to neutralise it.
    expect(JSON.stringify(ld).replace(/</g, "\\u003c")).not.toContain("</script>");
  });
});
