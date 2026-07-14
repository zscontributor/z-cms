import type { CSSProperties } from "react";
import type { MenuDto, MenuItemDto } from "@zcmsorg/schemas";
import {
  ColorModeToggle,
  defineTheme,
  type ArchiveTemplateProps,
  type BlockProps,
  type ErrorTemplateProps,
  type LayoutProps,
  type NotFoundTemplateProps,
  type PageTemplateProps,
  type ThemeContext,
  type ThemeManifest,
  type ThemeSeoOverrides,
} from "@zcmsorg/theme-sdk";
import manifestJson from "../theme.json";
import en from "./locales/en.json";
import ja from "./locales/ja.json";
import vi from "./locales/vi.json";

/**
 * Z Default — the theme every new Z-CMS site starts on, and the fallback the
 * runtime renders when a downloaded theme cannot be loaded.
 *
 * It talks to the Theme SDK and to nothing else: templates receive a ThemeContext
 * and a ContentDto, and that is the whole of their view of the platform. Nothing
 * here knows about Next.js, Prisma or cms-api, which is what lets the runtime swap
 * this package out for a marketplace theme without touching core.
 *
 * It renders on the SERVER, and ships no client JavaScript. Two things that
 * normally need it are handled without it:
 *
 *   - the language switcher is a native <details> disclosure over `ctx.alternates`,
 *   - the dark/light toggle is the SDK's own <ColorModeToggle>, which the runtime
 *     wires up: this theme declares in its manifest that it is drawn for both modes,
 *     says where the switch goes, and styles itself under html[data-theme="dark"].
 *     It never touches an event, a store, or an icon.
 */

export interface DefaultThemeSettings {
  primaryColor: string;
  siteTitle: string;
  logo: string;
  tagline: string;
  metaDescription: string;
  announcement: string;
  githubUrl: string;
  docsUrl: string;
  downloadUrl: string;
  showSearch: boolean;
  footerText: string;
  ogImage: string;
  favicon: string;
  twitterSite: string;
  noindex: boolean;
  organizationName: string;
  organizationUrl: string;
  organizationLogo: string;
  socialProfiles: string;
}

type Ctx = ThemeContext<DefaultThemeSettings>;

export const manifest = manifestJson as unknown as ThemeManifest;

// --------------------------------------------------------------------- helpers

/** Block props arrive as unknown JSON. Nothing below trusts their shape. */
function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null && !Array.isArray(item),
      )
    : [];
}

function formatDate(iso: string | null, locale: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString(locale, {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return "";
  }
}

/** Absolute URLs go to another site untouched; site-relative ones get the locale prefix. */
function itemHref(ctx: Ctx, item: MenuItemDto): string {
  return /^[a-z]+:\/\//i.test(item.url) || item.url.startsWith("#")
    ? item.url
    : ctx.url(item.url);
}

/**
 * A page inside the documentation site, whose root is a setting and may or may not
 * carry a trailing slash — and a locale segment, since the docs are per-language and
 * their bare root only redirects to one of them.
 */
function docsHref(docsUrl: string, path: string): string {
  return `${docsUrl.replace(/\/+$/, "")}/${path}/`;
}

/** "vi" -> "Tiếng Việt": the only name a reader looking for their language recognises. */
function localeName(locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: "language" }).of(locale) ?? locale;
  } catch {
    return locale;
  }
}

/** "one per line" is the least annoying way to type a list into a textarea. */
function parseLines(value: string | undefined): string[] | undefined {
  const lines = (value ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length ? lines : undefined;
}

// ------------------------------------------------------------------ navigation

/**
 * The language switcher.
 *
 * `ctx.alternates` lists only the locales this page *actually exists in*, so
 * nothing here can send a reader to a 404 — the failure that makes a switcher
 * worse than none. Fewer than two entries means there is nothing to switch
 * between, and the control disappears rather than showing a menu of one.
 */
function LanguageSwitcher({ ctx }: { ctx: Ctx }) {
  if (ctx.alternates.length < 2) return null;

  const current = ctx.alternates.find((a) => a.current) ?? ctx.alternates[0]!;

  return (
    <details className="zdefault__lang">
      <summary aria-label={ctx.t("language.switch")}>
        <span aria-hidden="true">🌐</span>
        <span>{current.locale}</span>
      </summary>
      <ul className="zdefault__lang-menu">
        {ctx.alternates.map((alternate) => (
          <li key={alternate.locale}>
            {/* `path` is already final. Passing it through ctx.url() would prefix it
                a second time, with the locale of the page being rendered. */}
            <a
              href={alternate.path}
              hrefLang={alternate.locale}
              lang={alternate.locale}
              aria-current={alternate.current ? "true" : undefined}
            >
              {alternate.flagUrl ? (
                <img
                  className="zdefault__lang-flag"
                  src={alternate.flagUrl}
                  alt=""
                  aria-hidden="true"
                  width={20}
                  height={15}
                  loading="lazy"
                />
              ) : null}
              <span>{localeName(alternate.locale)}</span>
            </a>
          </li>
        ))}
      </ul>
    </details>
  );
}

function PrimaryNav({ ctx, menu }: { ctx: Ctx; menu?: MenuDto }) {
  const items = menu?.items ?? [];
  if (items.length === 0) return null;

  return (
    <nav className="zdefault__links" aria-label={menu?.name ?? ctx.t("nav.primary")}>
      {items.map((item) => (
        <a
          key={item.id}
          href={itemHref(ctx, item)}
          {...(item.target === "_blank"
            ? { target: "_blank", rel: "noopener noreferrer" }
            : {})}
        >
          {item.label}
        </a>
      ))}
    </nav>
  );
}

/** Plain GET form: search is a URL, not an app. */
function SearchBox({ ctx }: { ctx: Ctx }) {
  return (
    <form className="zdefault__search" role="search" action={ctx.url("/search")} method="get">
      <label className="zdefault__skip" htmlFor="zdefault-q">
        {ctx.t("search.label")}
      </label>
      <input
        id="zdefault-q"
        type="search"
        name="q"
        placeholder={ctx.t("search.placeholder")}
      />
    </form>
  );
}

// ---------------------------------------------------------------------- layout

function Layout({ ctx, children }: LayoutProps<DefaultThemeSettings>) {
  const { settings, site, menus } = ctx;

  // Three sources, most specific first, and the order is the point of a site-level
  // brand: this theme's setting (a tweak that applies only while this theme is
  // active), then the SITE's brand (which survives a theme change), then what the
  // theme ships. Colour and logo used to live only at the first, which meant
  // switching theme silently lost the customer their brand.
  const brandStyle = {
    "--z-orange": settings.primaryColor || site.brand.primaryColor || "#fa5600",
  } as CSSProperties;

  const title = settings.siteTitle || site.name;
  const logo = settings.logo || site.brand.logo;
  const footerMenu = menus.footer;

  return (
    <div className="zdefault" style={brandStyle}>
      <a className="zdefault__skip" href="#main">
        {ctx.t("layout.skipToContent")}
      </a>

      {settings.announcement ? (
        <div className="zdefault__topbar">
          <span>{settings.announcement}</span>{" "}
          <a href={settings.githubUrl} target="_blank" rel="noopener noreferrer">
            {ctx.t("topbar.link")} →
          </a>
        </div>
      ) : null}

      <header className="zdefault__header">
        <div className="zdefault__container zdefault__nav">
          <a className="zdefault__brand" href={ctx.url("/")} aria-label={title}>
            {logo ? (
              // Empty alt, and the link carries the label: the logo IS the site name
              // here, so describing it again makes a screen reader say it twice.
              <img className="zdefault__brand-logo" src={ctx.asset(logo)} alt="" />
            ) : (
              <>
                <span className="zdefault__brand-mark" aria-hidden="true">
                  Z
                </span>
                <span>{title}</span>
              </>
            )}
          </a>

          <PrimaryNav ctx={ctx} menu={menus.primary} />

          <div className="zdefault__actions">
            {settings.showSearch ? <SearchBox ctx={ctx} /> : null}
            <LanguageSwitcher ctx={ctx} />
            {settings.docsUrl ? (
              <a
                className="zdefault__btn zdefault__btn--light"
                href={settings.docsUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {ctx.t("nav.docs")}
              </a>
            ) : null}
            {settings.githubUrl ? (
              <a
                className="zdefault__btn zdefault__btn--primary"
                href={settings.githubUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {ctx.t("nav.github")}
              </a>
            ) : null}
          </div>
        </div>
      </header>

      <main id="main">{children}</main>

      <footer className="zdefault__footer">
        <div className="zdefault__container zdefault__footer-grid">
          <div className="zdefault__footer-brand">
            <span className="zdefault__brand">
              <span className="zdefault__brand-mark" aria-hidden="true">
                Z
              </span>
              <span>{title}</span>
            </span>
            <p>{settings.metaDescription || settings.tagline}</p>
          </div>

          <div>
            <h4>{ctx.t("footer.product")}</h4>
            <ul>
              <li>
                <a href={ctx.url("/#about")}>{ctx.t("nav.about")}</a>
              </li>
              <li>
                <a href={ctx.url("/#features")}>{ctx.t("nav.features")}</a>
              </li>
              <li>
                <a href={ctx.url("/#ecosystem")}>{ctx.t("nav.ecosystem")}</a>
              </li>
              <li>
                <a href={settings.downloadUrl || settings.githubUrl}>
                  {ctx.t("footer.download")}
                </a>
              </li>
            </ul>
          </div>

          <div>
            <h4>{ctx.t("nav.developers")}</h4>
            <ul>
              <li>
                <a href={settings.docsUrl}>{ctx.t("footer.documentation")}</a>
              </li>
              <li>
                <a href={docsHref(settings.docsUrl, "developers/theme-handbook/getting-started")}>
                  Theme SDK
                </a>
              </li>
              <li>
                <a href={docsHref(settings.docsUrl, "developers/plugin-handbook/getting-started")}>
                  Plugin SDK
                </a>
              </li>
              <li>
                <a href={docsHref(settings.docsUrl, "developers/api-reference")}>
                  API Reference
                </a>
              </li>
            </ul>
          </div>

          <div>
            <h4>{ctx.t("nav.community")}</h4>
            <ul>
              <li>
                <a href={settings.githubUrl}>GitHub</a>
              </li>
              <li>
                <a href={`${settings.githubUrl}/discussions`}>
                  {ctx.t("footer.discussions")}
                </a>
              </li>
              <li>
                <a href={`${settings.githubUrl}/issues`}>{ctx.t("footer.issues")}</a>
              </li>
              <li>
                <a href={`${settings.githubUrl}/blob/main/CONTRIBUTING.md`}>
                  {ctx.t("community.contributeTitle")}
                </a>
              </li>
            </ul>
          </div>

          <div>
            <h4>{ctx.t("footer.about")}</h4>
            <ul>
              {footerMenu && footerMenu.items.length > 0 ? (
                footerMenu.items.map((item) => (
                  <li key={item.id}>
                    <a href={itemHref(ctx, item)}>{item.label}</a>
                  </li>
                ))
              ) : (
                <>
                  <li>
                    <a href={settings.organizationUrl || "https://z-soft.com.vn"}>
                      {settings.organizationName || "Z-SOFT"}
                    </a>
                  </li>
                  <li>
                    <a href={ctx.url("/blog")}>{ctx.t("nav.blog")}</a>
                  </li>
                  <li>
                    <a href={`${settings.githubUrl}/blob/main/LICENSE`}>
                      {ctx.t("footer.license")}
                    </a>
                  </li>
                </>
              )}
            </ul>
          </div>
        </div>

        <div className="zdefault__container zdefault__footer-bottom">
          <span>{settings.footerText}</span>
          <span>{settings.tagline}</span>
        </div>
      </footer>

      {/* Fixed, so it is reachable from anywhere on a long landing page. The
          scroll-to-top is an anchor rather than a button: "go back to the top" is a
          link to the top, and HTML has had that since 1993. */}
      <div className="zdefault__float">
        {/* The SDK's switch, not the theme's: the runtime wires up the click, the
            persistence and the icon swap. It renders nothing at all on a theme that
            declares a single colour mode, so a theme cannot ship a dead button. */}
        <ColorModeToggle ctx={ctx} className="zdefault__float-btn" />
        <a
          className="zdefault__float-btn"
          href="#main"
          aria-label={ctx.t("layout.backToTop")}
          title={ctx.t("layout.backToTop")}
        >
          <span aria-hidden="true">↑</span>
        </a>
      </div>
      {ctx.renderSlot("floating")}
    </div>
  );
}

// ------------------------------------------------------------------- templates

/**
 * The home page is the product landing page from the Z-CMS portal design: hero,
 * stack, what it is, what it does, the ecosystem, a look at the code, the
 * community, a call to action.
 *
 * The sections below are the theme's, not the site's — they are how this theme
 * presents a Z-CMS site to someone who has just arrived. Whatever blocks the
 * editor actually put on the home page render underneath, so the page stays
 * editable in the CMS rather than being frozen in this file.
 */
function HomeTemplate({ ctx, content }: PageTemplateProps<DefaultThemeSettings>) {
  const { settings } = ctx;

  // Declared in theme.json, fetched by cms-api, real rows out of the database. The
  // `?? []` is for a misspelt name, not for an empty site — cms-api always sends the
  // key, empty or not.
  const latest = ctx.collections.latest ?? [];

  return (
    <>
      <section className="zdefault__hero">
        <div className="zdefault__container zdefault__hero-grid">
          <div>
            <p className="zdefault__eyebrow">{settings.tagline}</p>
            <h1 className="zdefault__hero-title">
              {ctx.t("hero.title.first")}
              <br />
              <span>{ctx.t("hero.title.second")}</span>
            </h1>
            <p className="zdefault__hero-copy">{ctx.t("hero.copy")}</p>

            <div className="zdefault__hero-actions">
              <a
                className="zdefault__btn zdefault__btn--primary"
                href={settings.downloadUrl || settings.githubUrl}
              >
                {ctx.t("hero.primary")}
              </a>
              <a className="zdefault__btn" href={settings.docsUrl}>
                {ctx.t("hero.secondary")}
              </a>
            </div>

            <div className="zdefault__hero-meta">
              <span>MIT License</span>
              <span>Theme Engine</span>
              <span>Plugin Marketplace</span>
            </div>
          </div>

          <MockBrowser ctx={ctx} />
        </div>
      </section>

      <div className="zdefault__trust">
        <div className="zdefault__container zdefault__trust-row">
          <span className="zdefault__trust-label">{ctx.t("trust.label")}</span>
          <div className="zdefault__techs">
            <span>Next.js</span>
            <span>NestJS</span>
            <span>PostgreSQL</span>
            <span>Redis</span>
            <span>TypeScript</span>
          </div>
        </div>
      </div>

      <section className="zdefault__section" id="about">
        <div className="zdefault__container zdefault__intro-grid">
          <p className="zdefault__eyebrow">{ctx.t("about.eyebrow")}</p>
          <div>
            <h2 className="zdefault__big">{ctx.t("about.title")}</h2>
            <div className="zdefault__points">
              {[1, 2, 3, 4].map((n) => (
                <article className="zdefault__point" key={n}>
                  <span>{String(n).padStart(2, "0")}</span>
                  <h3>{ctx.t(`about.point${n}.title`)}</h3>
                  <p>{ctx.t(`about.point${n}.copy`)}</p>
                </article>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="zdefault__section zdefault__features" id="features">
        <div className="zdefault__container">
          <p className="zdefault__eyebrow">{ctx.t("features.eyebrow")}</p>
          <h2 className="zdefault__section-title">{ctx.t("features.title")}</h2>
          <p className="zdefault__section-copy">{ctx.t("features.copy")}</p>

          <div className="zdefault__feature-grid">
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <article className="zdefault__feature-card" key={n}>
                <span className="zdefault__feature-icon" aria-hidden="true">
                  {FEATURE_ICONS[n - 1]}
                </span>
                <div>
                  <h3>{ctx.t(`features.card${n}.title`)}</h3>
                  <p>{ctx.t(`features.card${n}.copy`)}</p>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="zdefault__section" id="ecosystem">
        <div className="zdefault__container">
          <div className="zdefault__ecosystem-head">
            <div>
              <p className="zdefault__eyebrow">{ctx.t("ecosystem.eyebrow")}</p>
              <h2 className="zdefault__section-title">{ctx.t("ecosystem.title")}</h2>
            </div>
            <p className="zdefault__section-copy">{ctx.t("ecosystem.copy")}</p>
          </div>

          <div className="zdefault__market-grid">
            {MARKET_CARDS.map((card) => (
              <article className="zdefault__market-card" key={card.name}>
                <div
                  className={`zdefault__market-preview zdefault__market-preview--${card.tone}`}
                >
                  <div className="zdefault__preview-window">
                    <span />
                    <span />
                    <div />
                  </div>
                </div>
                <div className="zdefault__market-body">
                  <div className="zdefault__market-meta">
                    <span className="zdefault__tag">{ctx.t(card.tagKey)}</span>
                    <span>{ctx.t("market.free")}</span>
                  </div>
                  <h3>{card.name}</h3>
                  <div className="zdefault__market-meta">
                    <span>{ctx.t("market.byZSoft")}</span>
                    <span aria-hidden="true">★★★★★</span>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="zdefault__section" id="developers">
        <div className="zdefault__container zdefault__code-wrap">
          <div>
            <p className="zdefault__eyebrow">{ctx.t("developers.eyebrow")}</p>
            <h2 className="zdefault__section-title">{ctx.t("developers.title")}</h2>
            <p className="zdefault__section-copy">{ctx.t("developers.copy")}</p>
            <a
              className="zdefault__btn zdefault__btn--dark"
              href={settings.docsUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {ctx.t("developers.cta")}
            </a>
          </div>
          <CodePanel />
        </div>
      </section>

      <section className="zdefault__section zdefault__community" id="community">
        <div className="zdefault__container">
          <p className="zdefault__eyebrow">{ctx.t("community.eyebrow")}</p>
          <h2 className="zdefault__section-title">{ctx.t("community.title")}</h2>
          <p className="zdefault__section-copy">{ctx.t("community.copy")}</p>

          <div className="zdefault__community-grid">
            <a href={settings.githubUrl} target="_blank" rel="noopener noreferrer">
              <strong>GitHub</strong>
              <span>{ctx.t("community.github")}</span>
            </a>
            <a href={settings.docsUrl} target="_blank" rel="noopener noreferrer">
              <strong>Docs</strong>
              <span>{ctx.t("community.docs")}</span>
            </a>
            <a
              href={`${settings.githubUrl}/discussions`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <strong>Forum</strong>
              <span>{ctx.t("community.forum")}</span>
            </a>
            <a
              href={`${settings.githubUrl}/blob/main/CONTRIBUTING.md`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <strong>{ctx.t("community.contributeTitle")}</strong>
              <span>{ctx.t("community.contribute")}</span>
            </a>
          </div>
        </div>
      </section>

      {/* The site's actual, published posts — not an invention of this theme.
          `latest` is declared in theme.json and run by cms-api against the database,
          so writing a post in the admin puts it here. An empty list is a normal state
          on a new site and says so out loud, because a section that renders nothing at
          all is indistinguishable from a bug. */}
      <section className="zdefault__section" id="blog">
        <div className="zdefault__container">
          <div className="zdefault__ecosystem-head">
            <div>
              <p className="zdefault__eyebrow">{ctx.t("latest.eyebrow")}</p>
              <h2 className="zdefault__section-title">{ctx.t("latest.title")}</h2>
            </div>
            <a className="zdefault__btn" href={ctx.url("/blog")}>
              {ctx.t("latest.all")}
            </a>
          </div>

          {latest.length === 0 ? (
            <p className="zdefault__section-copy">{ctx.t("latest.empty")}</p>
          ) : (
            <ul className="zdefault__post-grid">
              {latest.map((post) => (
                <li className="zdefault__post-card" key={post.id}>
                  <p className="zdefault__meta">
                    {formatDate(post.publishedAt, ctx.locale)}
                  </p>
                  <h3>
                    <a href={ctx.url(post.path)}>{post.title}</a>
                  </h3>
                  {post.excerpt ? <p>{post.excerpt}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* Whatever the editor actually put on the home page in the CMS. The landing
          sections above are the theme's opinion; this is the site's content. */}
      {content.blocks.length > 0 ? (
        <section className="zdefault__section" id="content">
          <div className="zdefault__container zdefault__prose">
            {ctx.renderBlocks(content.blocks)}
          </div>
        </section>
      ) : null}

      <section className="zdefault__cta" id="download">
        <div className="zdefault__container zdefault__cta-box">
          <h2>{ctx.t("cta.title")}</h2>
          <a
            className="zdefault__btn"
            href={settings.downloadUrl || settings.githubUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {ctx.t("cta.button")}
          </a>
        </div>
      </section>
    </>
  );
}

function PageTemplate({ ctx, content }: PageTemplateProps<DefaultThemeSettings>) {
  return (
    <article className="zdefault__article">
      <div className="zdefault__container zdefault__narrow">
        <p className="zdefault__eyebrow">{ctx.settings.siteTitle || ctx.site.name}</p>
        <h1 className="zdefault__article-title">{content.title}</h1>
        {content.excerpt ? <p className="zdefault__lede">{content.excerpt}</p> : null}
        <div className="zdefault__prose">{ctx.renderBlocks(content.blocks)}</div>
      </div>
    </article>
  );
}

function PostTemplate({ ctx, content }: PageTemplateProps<DefaultThemeSettings>) {
  const readingTime = Number((content.data as Record<string, unknown>)?.readingTime);

  return (
    <article className="zdefault__article">
      <div className="zdefault__container zdefault__narrow">
        <p className="zdefault__meta">
          <a href={ctx.url("/blog")}>← {ctx.t("post.backToPosts")}</a>
        </p>
        <h1 className="zdefault__article-title">{content.title}</h1>

        <p className="zdefault__meta">
          {[
            formatDate(content.publishedAt, ctx.locale),
            content.author?.name,
            Number.isFinite(readingTime) && readingTime > 0
              ? ctx.t("post.readingTime", { minutes: readingTime })
              : "",
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>

        {content.excerpt ? <p className="zdefault__lede">{content.excerpt}</p> : null}
        <div className="zdefault__rule" />
        <div className="zdefault__prose">{ctx.renderBlocks(content.blocks)}</div>
      </div>
    </article>
  );
}

function ArchiveTemplate({ ctx, archive }: ArchiveTemplateProps<DefaultThemeSettings>) {
  return (
    <section className="zdefault__article">
      <div className="zdefault__container zdefault__narrow">
        <p className="zdefault__eyebrow">{ctx.settings.siteTitle || ctx.site.name}</p>
        <h1 className="zdefault__article-title">{archive.title}</h1>

        {archive.items.length === 0 ? (
          <p className="zdefault__lede">{ctx.t("archive.empty")}</p>
        ) : (
          <ul className="zdefault__archive-list">
            {archive.items.map((item) => (
              <li key={item.id}>
                <p className="zdefault__meta">{formatDate(item.publishedAt, ctx.locale)}</p>
                <h2>
                  <a href={ctx.url(item.path)}>{item.title}</a>
                </h2>
                {item.excerpt ? <p>{item.excerpt}</p> : null}
              </li>
            ))}
          </ul>
        )}

        {archive.totalPages > 1 ? (
          <div className="zdefault__pagination">
            {archive.page > 1 ? (
              <a href={`${archive.basePath}?page=${archive.page - 1}`}>
                ← {ctx.t("archive.previous")}
              </a>
            ) : (
              <span />
            )}
            <span>
              {ctx.t("archive.pageOf", {
                page: archive.page,
                total: archive.totalPages,
              })}
            </span>
            {archive.page < archive.totalPages ? (
              <a href={`${archive.basePath}?page=${archive.page + 1}`}>
                {ctx.t("archive.next")} →
              </a>
            ) : (
              <span />
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function NotFoundTemplate({ ctx }: NotFoundTemplateProps<DefaultThemeSettings>) {
  return (
    <section className="zdefault__article">
      <div className="zdefault__container zdefault__narrow">
        <p className="zdefault__eyebrow">404</p>
        <h1 className="zdefault__article-title">{ctx.t("notFound.title")}</h1>
        <p className="zdefault__lede">{ctx.t("notFound.description")}</p>
        <a className="zdefault__btn zdefault__btn--primary" href={ctx.url("/")}>
          {ctx.t("notFound.backHome")}
        </a>
      </div>
    </section>
  );
}

function ErrorTemplate({
  ctx,
  statusCode,
  title,
  message,
  digest,
}: ErrorTemplateProps<DefaultThemeSettings>) {
  return (
    <section className="zdefault__article">
      <div className="zdefault__container zdefault__narrow">
        <p className="zdefault__eyebrow">{statusCode}</p>
        <h1 className="zdefault__article-title">{title || ctx.t("error.title")}</h1>
        <p className="zdefault__lede">{message || ctx.t("error.description")}</p>
        {/* The digest is the only thread between what the visitor saw and what the
            operator can find in the logs. Worth the ugly line of text. */}
        {digest ? (
          <p className="zdefault__meta">
            {ctx.t("error.reference")}: {digest}
          </p>
        ) : null}
        <a className="zdefault__btn zdefault__btn--primary" href={ctx.url("/")}>
          {ctx.t("error.backHome")}
        </a>
      </div>
    </section>
  );
}

// ------------------------------------------------------------- home decoration

const FEATURE_ICONS = ["[ ]", "</>", "{ }", "API", "TS", "◇"];

const MARKET_CARDS = [
  { tone: "one", name: "Z Default", tagKey: "market.business" },
  { tone: "two", name: "Z Market", tagKey: "market.commerce" },
  { tone: "three", name: "Z Magazine", tagKey: "market.publishing" },
] as const;

/** A picture of a website, drawn in CSS. No image to ship, and it re-colours in dark mode. */
function MockBrowser({ ctx }: { ctx: Ctx }) {
  return (
    <div className="zdefault__browser" role="img" aria-label={ctx.t("mock.aria")}>
      <div className="zdefault__browser-bar" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <div className="zdefault__mock" aria-hidden="true">
        <div className="zdefault__mock-nav">
          <b>ORIGIN</b>
          <span>Work Studio Journal</span>
        </div>
        <div className="zdefault__mock-hero">
          <p>DESIGNING DIGITAL EXPERIENCES</p>
          <strong>
            Ideas that
            <br />
            move people.
          </strong>
          <div className="zdefault__mock-btn">Explore projects</div>
        </div>
        <div className="zdefault__mock-cards">
          <div>
            Brand strategy<b>North Studio</b>
          </div>
          <div>
            Digital platform<b>Future Grid</b>
          </div>
          <div>
            Product design<b>Form &amp; Function</b>
          </div>
        </div>
      </div>
    </div>
  );
}

function CodePanel() {
  return (
    <div className="zdefault__terminal">
      <div className="zdefault__terminal-top" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <pre>{`import { definePlugin } from "@zcmsorg/plugin-sdk";

export default definePlugin({
  id: "vn.zsoft.plugin.seo",
  name: "Z SEO",
  permissions: ["content:read"],

  setup(cms) {
    cms.hooks.on("content.published", async ({ contentId }) => {
      await cms.jobs.enqueue("generate-sitemap", { contentId });
    });
  },
});`}</pre>
    </div>
  );
}

// ----------------------------------------------------------------------- blocks

function HeroBlock({ props }: BlockProps<Record<string, unknown>, DefaultThemeSettings>) {
  return (
    <section className="zdefault__block-hero">
      {props.eyebrow ? <p className="zdefault__eyebrow">{str(props.eyebrow)}</p> : null}
      <h2>{str(props.heading)}</h2>
      {props.subheading ? (
        <p className="zdefault__section-copy" style={{ margin: "0 auto" }}>
          {str(props.subheading)}
        </p>
      ) : null}
      {props.ctaLabel && props.ctaHref ? (
        <p style={{ marginTop: 24 }}>
          <a className="zdefault__btn zdefault__btn--primary" href={str(props.ctaHref)}>
            {str(props.ctaLabel)}
          </a>
        </p>
      ) : null}
    </section>
  );
}

/**
 * Authored HTML, rendered as HTML.
 *
 * `dangerouslySetInnerHTML` is doing exactly what it says, and it is safe here for
 * a reason that lives outside this file: cms-api sanitises `props.html` at WRITE
 * time — `sanitizeBlocks` (apps/cms-api/src/common/sanitize-blocks.ts) runs on every
 * path that persists blocks, so what is stored, and therefore what reaches a theme,
 * has already had its scripts, event handlers, `javascript:` URLs and framing tags
 * (<iframe>, <object>, <form>) stripped against a strict allowlist.
 *
 * The public site's CSP is the BACKSTOP, not the defence: an inline <script> that
 * somehow reached this HTML would carry no nonce and the browser would refuse to run
 * it — but CSP would not stop an <iframe> or a `javascript:` href. Sanitising does.
 */
function RichTextBlock({ props }: BlockProps<Record<string, unknown>, DefaultThemeSettings>) {
  return <div dangerouslySetInnerHTML={{ __html: str(props.html) }} />;
}

function FeaturesBlock({ props }: BlockProps<Record<string, unknown>, DefaultThemeSettings>) {
  const items = list(props.items);

  return (
    <section className="zdefault__block-section">
      {props.heading ? <h2>{str(props.heading)}</h2> : null}
      {props.subheading ? <p>{str(props.subheading)}</p> : null}
      <div className="zdefault__block-features">
        {items.map((item, index) => (
          <article key={index}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <h3>{str(item.title)}</h3>
            <p>{str(item.body)}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function ImageBlock({ props }: BlockProps<Record<string, unknown>, DefaultThemeSettings>) {
  const src = str(props.src ?? props.url);
  if (!src) return null;

  return (
    <figure className="zdefault__figure">
      <img src={src} alt={str(props.alt)} loading="lazy" />
      {props.caption ? <figcaption>{str(props.caption)}</figcaption> : null}
    </figure>
  );
}

/**
 * `core/content-list` — a list an EDITOR placed, rather than one the theme declared.
 *
 * Its props are a query ("6 posts, newest first"), and cms-api has already run it: the
 * rows arrive in `props.items`, resolved server-side. So the block is rendered exactly
 * like the home page's `latest` section, from the same kind of data, and this theme
 * needs no idea that a database was involved either time.
 *
 * `layout` is a hint, not a command — the editor asks for a grid, and the theme decides
 * what a grid looks like here.
 */
function ContentListBlock({
  props,
  ctx,
}: BlockProps<Record<string, unknown>, DefaultThemeSettings>) {
  const items = list(props.items);
  const grid = str(props.layout, "list") === "grid";

  return (
    <section className="zdefault__block-section">
      {props.heading ? <h2>{str(props.heading)}</h2> : null}

      {items.length === 0 ? (
        <p>{ctx.t("latest.empty")}</p>
      ) : (
        <ul className={grid ? "zdefault__post-grid" : "zdefault__archive-list"}>
          {items.map((item, index) => {
            const path = str(item.path);
            const title = str(item.title);

            return (
              <li className={grid ? "zdefault__post-card" : undefined} key={str(item.id, String(index))}>
                <p className="zdefault__meta">
                  {formatDate(
                    typeof item.publishedAt === "string" ? item.publishedAt : null,
                    ctx.locale,
                  )}
                </p>
                <h3>{path ? <a href={ctx.url(path)}>{title}</a> : title}</h3>
                {item.excerpt ? <p>{str(item.excerpt)}</p> : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function CtaBlock({ props }: BlockProps<Record<string, unknown>, DefaultThemeSettings>) {
  return (
    <section className="zdefault__block-cta">
      <h2>{str(props.heading)}</h2>
      {props.body ? <p>{str(props.body)}</p> : null}
      {props.ctaLabel && props.ctaHref ? (
        <a className="zdefault__btn zdefault__btn--primary" href={str(props.ctaHref)}>
          {str(props.ctaLabel)}
        </a>
      ) : null}
    </section>
  );
}

// ------------------------------------------------------------------------ theme

const theme = defineTheme<DefaultThemeSettings>({
  manifest,
  Layout,
  templates: {
    home: HomeTemplate,
    page: PageTemplate,
    post: PostTemplate,
    archive: ArchiveTemplate,
    notFound: NotFoundTemplate,
    error: ErrorTemplate,
  },
  blocks: {
    "core/hero": HeroBlock,
    "core/richtext": RichTextBlock,
    "core/features": FeaturesBlock,
    "core/image": ImageBlock,
    "core/cta": CtaBlock,
    "core/content-list": ContentListBlock,
  },

  // The theme's own strings, in the theme's own catalogue. English is the base: a
  // locale this theme has never been translated into falls back to it, so the theme
  // keeps rendering on a site in any language.
  messages: { en, ja, vi },

  /**
   * Settings -> document head.
   *
   * An empty setting is left `undefined` rather than passed through as "" — the SDK
   * then falls back to the manifest default, where an empty string would suppress it.
   */
  seo: (ctx): ThemeSeoOverrides => {
    const s = ctx.settings;

    return {
      defaultTitle: s.siteTitle || undefined,
      description: s.metaDescription || s.tagline || undefined,
      ogImage: s.ogImage || undefined,
      twitterSite: s.twitterSite || undefined,
      robots: s.noindex ? { index: false, follow: false } : undefined,

      icons: {
        ...(s.favicon ? { favicon: s.favicon, icon: s.favicon } : {}),
        // The same order the Layout uses for `--z-orange`: this theme's setting, then
        // the site's brand. The address bar and the header must not disagree about
        // what colour the site is.
        themeColor: s.primaryColor || ctx.site.brand.primaryColor || undefined,
      },

      organization: {
        name: s.organizationName || s.siteTitle || "",
        url: s.organizationUrl || undefined,
        logo: s.organizationLogo || undefined,
        sameAs: parseLines(s.socialProfiles),
      },
    };
  },
});

export default theme;
export { Layout };
