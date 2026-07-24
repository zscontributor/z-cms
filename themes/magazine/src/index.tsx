import type { CSSProperties } from "react";
import type { ContentDto, MenuDto, MenuItemDto } from "@zcmsorg/schemas";
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
 * Z Magazine — an editorial theme for news sites, magazines and publications.
 *
 * It is a front page, not a blog: a dateline bar, a centred serif masthead between
 * two rules, a section nav, a lead story with secondaries beside it, a river of
 * latest news, a most-read rail and a newsletter box. Information is dense and the
 * rules are hairlines, because that is what a newspaper looks like.
 *
 * Every story on that front page is a story the SITE published. The theme declares in
 * its manifest which list it needs (`collections.latest`), core runs the query, and the
 * rows arrive on `ctx.collections` — so a newsroom that writes a story in the admin
 * sees it lead the paper, and this theme still never learns that a database exists.
 *
 * It talks to the Theme SDK and to nothing else: templates receive a ThemeContext
 * and a ContentDto, and that is the whole of their view of the platform. Nothing
 * here knows about Next.js, Prisma or cms-api.
 *
 * It renders on the SERVER, and ships no client JavaScript. The two controls that
 * normally need it do not:
 *
 *   - the language switcher is a native <details> disclosure over `ctx.alternates`,
 *   - the dark/light toggle is the SDK's own <ColorModeToggle>, which the runtime
 *     wires up: this theme declares in its manifest that it is drawn for both modes,
 *     says where the switch goes, and styles itself under html[data-theme="dark"].
 *     It never touches an event, a store, or an icon.
 *
 * No photographs ship with the theme, so every image area on the front page is
 * drawn in CSS. See src/theme.css.
 */

export interface MagazineThemeSettings {
  primaryColor: string;
  siteTitle: string;
  logo: string;
  tagline: string;
  metaDescription: string;
  announcement: string;
  showSearch: boolean;
  featuredCount: number;
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

type Ctx = ThemeContext<MagazineThemeSettings>;

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

/** A content type's custom fields are unknown JSON too — same rule as block props. */
function field(data: unknown, key: string): string {
  if (typeof data !== "object" || data === null) return "";
  const value = (data as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function numberField(data: unknown, key: string): number {
  if (typeof data !== "object" || data === null) return 0;
  const value = (data as Record<string, unknown>)[key];
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** The dateline: the long form a masthead prints under it. */
function formatDateline(date: Date, locale: string): string {
  try {
    return date.toLocaleDateString(locale, {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function formatDate(iso: string | null, locale: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString(locale, {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  } catch {
    return "";
  }
}

/**
 * The line of small caps above a headline: "World · The long read".
 *
 * `category` and `kicker` are fields on the `post` content type, so an editor writes
 * them; a story that has neither falls back to the theme's own word for a report,
 * because a headline with nothing above it loses the rhythm of the page.
 */
function StoryKicker({ ctx, item }: { ctx: Ctx; item: ContentDto }) {
  const text =
    [field(item.data, "category"), field(item.data, "kicker")].filter(Boolean).join(" · ") ||
    ctx.t("post.kicker");

  return <p className="zmag__kicker">{text}</p>;
}

/** "By Mai Tran · 14 May 2026" — whichever of the two the row actually has. */
function byline(ctx: Ctx, item: ContentDto): string {
  return [
    item.author?.name ? ctx.t("post.byline", { author: item.author.name }) : "",
    formatDate(item.publishedAt, ctx.locale),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Absolute URLs go to another site untouched; site-relative ones get the locale prefix. */
function itemHref(ctx: Ctx, item: MenuItemDto): string {
  return /^[a-z]+:\/\//i.test(item.url) || item.url.startsWith("#")
    ? item.url
    : ctx.url(item.url);
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

/**
 * How many stories the "latest" river prints, at most — the site may have published
 * fewer, and then it prints those.
 *
 * The setting is a number from the admin, which means it can arrive as anything.
 * Clamped rather than trusted: a river of 0 is an empty band, and a river of 40 asks
 * for more rows than the manifest's collection is allowed to fetch.
 */
function featuredCount(settings: MagazineThemeSettings): number {
  const raw = Number(settings.featuredCount);
  if (!Number.isFinite(raw)) return LATEST_ITEMS;
  return Math.min(LATEST_ITEMS, Math.max(3, Math.round(raw)));
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
    <details className="zmag__lang">
      <summary aria-label={ctx.t("language.switch")}>
        <span aria-hidden="true">🌐</span>
        <span>{current.locale}</span>
      </summary>
      <ul className="zmag__lang-menu">
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
                  className="zmag__lang-flag"
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

/** The section row under the masthead: the spine of a newspaper's navigation. */
function SectionNav({ ctx, menu }: { ctx: Ctx; menu?: MenuDto }) {
  const items = menu?.items ?? [];
  if (items.length === 0) return null;

  return (
    <nav className="zmag__sections" aria-label={menu?.name ?? ctx.t("nav.primary")}>
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <a
              href={itemHref(ctx, item)}
              {...(item.target === "_blank"
                ? { target: "_blank", rel: "noopener noreferrer" }
                : {})}
            >
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Plain GET form: search is a URL, not an app. */
function SearchBox({ ctx }: { ctx: Ctx }) {
  return (
    <form className="zmag__search" role="search" action={ctx.url("/search")} method="get">
      <label className="zmag__skip" htmlFor="zmag-q">
        {ctx.t("search.label")}
      </label>
      <input
        id="zmag-q"
        type="search"
        name="q"
        placeholder={ctx.t("search.placeholder")}
      />
      <button type="submit">{ctx.t("search.submit")}</button>
    </form>
  );
}

/**
 * A photograph that is not a photograph.
 *
 * The theme ships no images — a marketplace package that carried a stock photo per
 * story would be megabytes of pictures nobody keeps. Every "image" on the front
 * page is this: two gradients and a rule, tinted by a modifier, re-coloured with
 * the palette in dark mode. It is a picture *area*, and it is meant to read as an
 * intentional one rather than as a missing file.
 */
function Art({
  tone,
  ratio,
  label,
}: {
  tone: "one" | "two" | "three" | "four" | "five";
  ratio?: "wide" | "tall" | "square";
  label: string;
}) {
  return (
    <div
      className={[
        "zmag__art",
        `zmag__art--${tone}`,
        ratio ? `zmag__art--${ratio}` : "",
      ]
        .filter(Boolean)
        .join(" ")}
      role="img"
      aria-label={label}
    >
      <span aria-hidden="true" />
      <i aria-hidden="true" />
    </div>
  );
}

// ---------------------------------------------------------------------- layout

function Layout({ ctx, children }: LayoutProps<MagazineThemeSettings>) {
  const { settings, site, menus } = ctx;

  // Three sources, most specific first, and the order is the point of a site-level
  // brand: this theme's setting (a tweak that applies only while this theme is
  // active), then the SITE's brand (which survives a theme change), then what the
  // theme ships.
  const brandStyle = {
    "--z-accent": settings.primaryColor || site.brand.primaryColor || "#C0392B",
  } as CSSProperties;

  const title = settings.siteTitle || site.name;
  const logo = settings.logo || site.brand.logo;
  const footerMenu = menus.footer;
  const primaryMenu = menus.primary;
  const now = new Date();

  return (
    <div className="zmag" style={brandStyle}>
      <a className="zmag__skip" href="#main">
        {ctx.t("layout.skipToContent")}
      </a>

      {/* Breaking news. A strip, not a banner: it is a headline, and it reads as one. */}
      {settings.announcement ? (
        <div className="zmag__breaking">
          <div className="zmag__container zmag__breaking-row">
            <span className="zmag__breaking-label">{ctx.t("breaking.label")}</span>
            <span className="zmag__breaking-text">{settings.announcement}</span>
          </div>
        </div>
      ) : null}

      <div className="zmag__dateline">
        <div className="zmag__container zmag__dateline-row">
          <time className="zmag__dateline-date" dateTime={now.toISOString().slice(0, 10)}>
            {formatDateline(now, ctx.locale)}
          </time>
          <span className="zmag__dateline-edition">
            {ctx.t("dateline.edition")} · {ctx.t("dateline.price")}
          </span>
          <div className="zmag__dateline-tools">
            <LanguageSwitcher ctx={ctx} />
            {/* The SDK's switch, not the theme's: the runtime wires up the click, the
                persistence and the icon swap. It renders nothing at all on a theme that
                declares a single colour mode, so a theme cannot ship a dead button. */}
            <ColorModeToggle ctx={ctx} className="zmag__toggle" />
          </div>
        </div>
      </div>

      <header className="zmag__masthead">
        <div className="zmag__container">
          <a className="zmag__wordmark" href={ctx.url("/")} aria-label={title}>
            {logo ? (
              // Empty alt, and the link carries the label: the logo IS the title
              // here, so describing it again makes a screen reader say it twice.
              <img className="zmag__wordmark-logo" src={ctx.asset(logo)} alt="" />
            ) : (
              <span className="zmag__wordmark-text">{title}</span>
            )}
          </a>
          {settings.tagline ? (
            <p className="zmag__masthead-tagline">{settings.tagline}</p>
          ) : null}
        </div>

        <div className="zmag__nav">
          <div className="zmag__container zmag__nav-row">
            <SectionNav ctx={ctx} menu={primaryMenu} />
            {settings.showSearch ? <SearchBox ctx={ctx} /> : null}
          </div>
        </div>
      </header>

      <main id="main">{children}</main>

      <footer className="zmag__footer">
        <div className="zmag__container">
          <div className="zmag__footer-grid">
            <div className="zmag__footer-brand">
              <span className="zmag__footer-wordmark">{title}</span>
              <p>{settings.metaDescription || settings.tagline}</p>
              <p className="zmag__footer-org">
                <a href={settings.organizationUrl || "https://z-soft.com.vn"}>
                  {settings.organizationName || "Z-SOFT"}
                </a>
              </p>
            </div>

            <div className="zmag__footer-col">
              <h2>{ctx.t("footer.sections")}</h2>
              <ul>
                {primaryMenu && primaryMenu.items.length > 0 ? (
                  primaryMenu.items.map((item) => (
                    <li key={item.id}>
                      <a href={itemHref(ctx, item)}>{item.label}</a>
                    </li>
                  ))
                ) : (
                  <li>
                    <a href={ctx.url("/news")}>{ctx.t("nav.news")}</a>
                  </li>
                )}
              </ul>
            </div>

            <div className="zmag__footer-col">
              <h2>{ctx.t("footer.about")}</h2>
              <ul>
                {footerMenu && footerMenu.items.length > 0 ? (
                  footerMenu.items.map((item) => (
                    <li key={item.id}>
                      <a href={itemHref(ctx, item)}>{item.label}</a>
                    </li>
                  ))
                ) : (
                  <li>
                    <a href={ctx.url("/about")}>{ctx.t("nav.about")}</a>
                  </li>
                )}
              </ul>
            </div>

            <div className="zmag__footer-col">
              <h2>{ctx.t("footer.follow")}</h2>
              <ul>
                {(parseLines(settings.socialProfiles) ?? []).map((href) => (
                  <li key={href}>
                    <a href={href} target="_blank" rel="noopener noreferrer">
                      {href.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}
                    </a>
                  </li>
                ))}
                <li>
                  <a href={ctx.url("/newsletter")}>{ctx.t("footer.newsletter")}</a>
                </li>
              </ul>
            </div>
          </div>

          <div className="zmag__footer-bottom">
            <span>{settings.footerText}</span>
            <a href="#main">{ctx.t("layout.backToTop")} ↑</a>
          </div>
        </div>
      </footer>
      {ctx.renderSlot("floating")}
    </div>
  );
}

// ------------------------------------------------------------------- templates

/**
 * The front page.
 *
 * Every story on it is a story the site has actually published. `latest` is declared
 * in theme.json, run by cms-api against this site's own database, and arrives on
 * `ctx.collections.latest` as rows — so the lead, the two secondaries, the river and
 * the most-read rail are one list, laid out the way a front page lays a list out:
 *
 *   [0]      the lead
 *   [1],[2]  the secondaries beside it
 *   [3…]     the river below, as many as `featuredCount` allows
 *   [0…4]    the rail, which is the same paper's own top stories
 *
 * The headline, the standfirst, the byline, the date, the kicker and the category all
 * come off the row. What stays in the theme's own catalogue is the CHROME — the words
 * "Latest" and "Most read", the editor's note, the dateline — because those are what
 * this theme is, not what the site says.
 *
 * A newspaper with nothing in it is a normal state on the day the theme is installed,
 * and it says so out loud: an empty front page renders a visible, translated notice
 * rather than a blank hole, which is indistinguishable from a bug.
 */
function HomeTemplate({ ctx, content }: PageTemplateProps<MagazineThemeSettings>) {
  const { settings } = ctx;
  const newsPath = ctx.url("/news");

  // Declared in theme.json, fetched by cms-api. The `?? []` is not for an empty site —
  // cms-api always sends every declared key — it is for a misspelt one.
  const stories = ctx.collections.latest ?? [];
  const lead = stories[0];
  const secondaries = stories.slice(1, 3);
  const river = stories.slice(3, 3 + featuredCount(settings));
  // The rail is a slice, not a metric: this theme has no analytics, and inventing a
  // reading count would be a lie printed in a box. It is the paper's own front stories,
  // which is the honest thing a "most read" rail can be without a plugin behind it.
  const mostRead = stories.slice(0, 5);

  return (
    <>
      {/* ------------------------------------------------------------ lead */}
      <section className="zmag__front" aria-label={ctx.t("front.label")}>
        <div
          className={
            secondaries.length > 0
              ? "zmag__container zmag__front-grid"
              : "zmag__container zmag__front-grid zmag__front-grid--solo"
          }
        >
          {lead ? (
            <article className="zmag__lead">
              <StoryKicker ctx={ctx} item={lead} />
              <h1 className="zmag__lead-headline">
                <a href={ctx.url(lead.path)}>{lead.title}</a>
              </h1>
              {lead.excerpt ? <p className="zmag__lede">{lead.excerpt}</p> : null}
              <p className="zmag__byline">{byline(ctx, lead)}</p>
              <Art tone="one" ratio="wide" label={lead.title} />
              <p className="zmag__caption">{ctx.t("front.caption")}</p>
            </article>
          ) : (
            <div className="zmag__empty">
              <p className="zmag__kicker">{ctx.t("latest.title")}</p>
              <p>{ctx.t("latest.empty")}</p>
            </div>
          )}

          {secondaries.length > 0 ? (
            <div className="zmag__secondaries">
              {secondaries.map((item, index) => (
                <article className="zmag__secondary" key={item.id}>
                  <StoryKicker ctx={ctx} item={item} />
                  <h2>
                    <a href={ctx.url(item.path)}>{item.title}</a>
                  </h2>
                  {item.excerpt ? <p>{item.excerpt}</p> : null}
                  <Art
                    tone={index === 0 ? "two" : "three"}
                    ratio="square"
                    label={item.title}
                  />
                </article>
              ))}
            </div>
          ) : null}
        </div>
      </section>

      {/* ------------------------------------------- latest + most read rail

          Only once there is more paper than the lead and its two secondaries. A river
          headed "Latest" above three stories that are already at the top of the page
          would be the same news printed twice. */}
      {river.length > 0 ? (
        <section className="zmag__band">
          <div className="zmag__container zmag__split">
            <div>
              <h2 className="zmag__band-title">
                <span>{ctx.t("latest.title")}</span>
                <a href={newsPath}>{ctx.t("common.seeAll")} →</a>
              </h2>

              <div className="zmag__river">
                {river.map((item) => (
                  <article className="zmag__river-item" key={item.id}>
                    <StoryKicker ctx={ctx} item={item} />
                    <h3>
                      <a href={ctx.url(item.path)}>{item.title}</a>
                    </h3>
                    {item.excerpt ? <p>{item.excerpt}</p> : null}
                    <p className="zmag__byline">{byline(ctx, item)}</p>
                  </article>
                ))}
              </div>
            </div>

            <aside className="zmag__mostread" aria-label={ctx.t("mostRead.title")}>
              <h2 className="zmag__rail-title">{ctx.t("mostRead.title")}</h2>
              <ol className="zmag__mostread-list">
                {mostRead.map((item, index) => (
                  <li key={item.id}>
                    <span aria-hidden="true">{index + 1}</span>
                    <a href={ctx.url(item.path)}>{item.title}</a>
                  </li>
                ))}
              </ol>

              <div className="zmag__rail-note">
                <p className="zmag__kicker">{ctx.t("mostRead.noteKicker")}</p>
                <p>{ctx.t("mostRead.note")}</p>
              </div>
            </aside>
          </div>
        </section>
      ) : null}

      {/* Whatever the editor actually put on the home page in the CMS. The front
          page above is the theme's opinion; this is the site's content. */}
      {content.blocks.length > 0 ? (
        <section className="zmag__band" id="content">
          <div className="zmag__container zmag__prose zmag__measure">
            {ctx.renderBlocks(content.blocks)}
          </div>
        </section>
      ) : null}

      {/* ------------------------------------------------------ newsletter */}
      <section className="zmag__newsletter" id="newsletter">
        <div className="zmag__container zmag__newsletter-box">
          <div>
            <p className="zmag__kicker">{ctx.t("newsletter.kicker")}</p>
            <h2>{ctx.t("newsletter.title")}</h2>
            <p>{ctx.t("newsletter.copy")}</p>
          </div>

          {/* A GET form to a page. Subscribing is a request, and HTML has had one
              since 1993 — no JavaScript is involved on either side of it. */}
          <form className="zmag__newsletter-form" action={ctx.url("/newsletter")} method="get">
            <label htmlFor="zmag-email">{ctx.t("newsletter.label")}</label>
            <div className="zmag__newsletter-row">
              <input
                id="zmag-email"
                type="email"
                name="email"
                required
                placeholder={ctx.t("newsletter.placeholder")}
              />
              <button type="submit">{ctx.t("newsletter.submit")}</button>
            </div>
            <p className="zmag__newsletter-note">{ctx.t("newsletter.note")}</p>
          </form>
        </div>
      </section>
    </>
  );
}

/** An ordinary page — the masthead/about page, the contact page, the legal notice. */
function PageTemplate({ ctx, content }: PageTemplateProps<MagazineThemeSettings>) {
  return (
    <article className="zmag__page">
      <div className="zmag__container zmag__measure">
        <p className="zmag__kicker">{ctx.settings.siteTitle || ctx.site.name}</p>
        <h1 className="zmag__page-title">{content.title}</h1>
        {content.excerpt ? <p className="zmag__lede">{content.excerpt}</p> : null}
        <hr className="zmag__rule" />
        <div className="zmag__prose">{ctx.renderBlocks(content.blocks)}</div>
      </div>
    </article>
  );
}

/**
 * An article.
 *
 * Kicker, headline, standfirst, byline, art, body — the order a printed page uses,
 * for the reason it uses it: each line tells the reader whether the next one is
 * worth their time. The body sits in a ~68ch measure, which is the width at which a
 * serif is comfortable to read and the reason a broadsheet is set in columns.
 */
function PostTemplate({ ctx, content }: PageTemplateProps<MagazineThemeSettings>) {
  const kicker = field(content.data, "kicker");
  const category = field(content.data, "category");
  const minutes = numberField(content.data, "readingTime");
  const sections = ctx.menus.primary?.items ?? [];

  return (
    <article className="zmag__article">
      <div className="zmag__container zmag__measure">
        <p className="zmag__kicker">
          {[category, kicker].filter(Boolean).join(" · ") || ctx.t("post.kicker")}
        </p>

        <h1 className="zmag__article-headline">{content.title}</h1>

        {content.excerpt ? <p className="zmag__standfirst">{content.excerpt}</p> : null}

        <div className="zmag__article-meta">
          <span className="zmag__byline">
            {content.author?.name
              ? ctx.t("post.byline", { author: content.author.name })
              : ctx.t("post.bylineStaff")}
          </span>
          <span className="zmag__article-meta-sep" aria-hidden="true" />
          {content.publishedAt ? (
            <time dateTime={content.publishedAt}>
              {formatDate(content.publishedAt, ctx.locale)}
            </time>
          ) : null}
          {minutes > 0 ? (
            <>
              <span className="zmag__article-meta-sep" aria-hidden="true" />
              <span>{ctx.t("post.readingTime", { minutes })}</span>
            </>
          ) : null}
        </div>
      </div>

      <div className="zmag__container">
        <Art tone="one" ratio="wide" label={content.title} />
        {content.excerpt ? <p className="zmag__caption">{content.excerpt}</p> : null}
      </div>

      <div className="zmag__container zmag__measure">
        <div className="zmag__prose zmag__prose--dropcap">
          {ctx.renderBlocks(content.blocks)}
        </div>

        <aside className="zmag__more" aria-label={ctx.t("post.moreFrom")}>
          <h2 className="zmag__rail-title">{ctx.t("post.moreFrom")}</h2>
          <ul>
            <li>
              <a href={ctx.url("/news")}>{ctx.t("post.allNews")}</a>
            </li>
            {sections.map((item) => (
              <li key={item.id}>
                <a href={itemHref(ctx, item)}>{item.label}</a>
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </article>
  );
}

/** A section front: the category headline, then a river of everything filed under it. */
function ArchiveTemplate({ ctx, archive }: ArchiveTemplateProps<MagazineThemeSettings>) {
  return (
    <section className="zmag__page">
      <div className="zmag__container">
        <header className="zmag__section-front">
          <p className="zmag__kicker">{ctx.t("archive.eyebrow")}</p>
          <h1 className="zmag__section-front-title">{archive.title}</h1>
          <hr className="zmag__rule zmag__rule--thick" />
        </header>

        {archive.items.length === 0 ? (
          <p className="zmag__lede">{ctx.t("archive.empty")}</p>
        ) : (
          <div className="zmag__archive">
            {archive.items.map((item) => {
              const kicker = field(item.data, "category") || field(item.data, "kicker");
              const minutes = numberField(item.data, "readingTime");

              return (
                <article className="zmag__archive-item" key={item.id}>
                  <Art tone="five" ratio="square" label={item.title} />
                  <div>
                    {kicker ? <p className="zmag__kicker">{kicker}</p> : null}
                    <h2>
                      <a href={ctx.url(item.path)}>{item.title}</a>
                    </h2>
                    {item.excerpt ? <p>{item.excerpt}</p> : null}
                    <p className="zmag__byline">
                      {[
                        item.author?.name
                          ? ctx.t("post.byline", { author: item.author.name })
                          : "",
                        formatDate(item.publishedAt, ctx.locale),
                        minutes > 0 ? ctx.t("post.readingTime", { minutes }) : "",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                </article>
              );
            })}
          </div>
        )}

        {archive.totalPages > 1 ? (
          <nav className="zmag__pagination" aria-label={ctx.t("archive.pagination")}>
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
          </nav>
        ) : null}
      </div>
    </section>
  );
}

function NotFoundTemplate({ ctx }: NotFoundTemplateProps<MagazineThemeSettings>) {
  return (
    <section className="zmag__status">
      <div className="zmag__container zmag__measure">
        <p className="zmag__status-code">404</p>
        <h1 className="zmag__article-headline">{ctx.t("notFound.title")}</h1>
        <p className="zmag__standfirst">{ctx.t("notFound.description")}</p>
        <hr className="zmag__rule" />
        <p className="zmag__status-actions">
          <a className="zmag__btn" href={ctx.url("/")}>
            {ctx.t("notFound.backHome")}
          </a>
          <a className="zmag__btn zmag__btn--ghost" href={ctx.url("/news")}>
            {ctx.t("notFound.browseNews")}
          </a>
        </p>
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
}: ErrorTemplateProps<MagazineThemeSettings>) {
  return (
    <section className="zmag__status">
      <div className="zmag__container zmag__measure">
        <p className="zmag__status-code">{statusCode}</p>
        <h1 className="zmag__article-headline">{title || ctx.t("error.title")}</h1>
        <p className="zmag__standfirst">{message || ctx.t("error.description")}</p>
        {/* The digest is the only thread between what the visitor saw and what the
            operator can find in the logs. Worth the ugly line of text. */}
        {digest ? (
          <p className="zmag__byline">
            {ctx.t("error.reference")}: {digest}
          </p>
        ) : null}
        <hr className="zmag__rule" />
        <p className="zmag__status-actions">
          <a className="zmag__btn" href={ctx.url("/")}>
            {ctx.t("error.backHome")}
          </a>
        </p>
      </div>
    </section>
  );
}

// ------------------------------------------------------- front-page decoration

/** The longest river this layout is drawn for. `featuredCount` clamps to it. */
const LATEST_ITEMS = 6;

// ----------------------------------------------------------------------- blocks

function HeroBlock({ props }: BlockProps<Record<string, unknown>, MagazineThemeSettings>) {
  return (
    <section className="zmag__block-hero">
      {props.eyebrow ? <p className="zmag__kicker">{str(props.eyebrow)}</p> : null}
      <h2>{str(props.heading)}</h2>
      {props.subheading ? (
        <p className="zmag__standfirst">{str(props.subheading)}</p>
      ) : null}
      {props.ctaLabel && props.ctaHref ? (
        <p>
          <a className="zmag__btn" href={str(props.ctaHref)}>
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
function RichTextBlock({
  props,
}: BlockProps<Record<string, unknown>, MagazineThemeSettings>) {
  return <div dangerouslySetInnerHTML={{ __html: str(props.html) }} />;
}

/** In a magazine a "feature list" is a fact box: numbered, ruled, set tight. */
function FeaturesBlock({
  props,
}: BlockProps<Record<string, unknown>, MagazineThemeSettings>) {
  const items = list(props.items);

  return (
    <section className="zmag__factbox">
      {props.heading ? <h2>{str(props.heading)}</h2> : null}
      {props.subheading ? <p className="zmag__factbox-sub">{str(props.subheading)}</p> : null}
      <ol>
        {items.map((item, index) => (
          <li key={index}>
            <span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
            <div>
              <h3>{str(item.title)}</h3>
              <p>{str(item.body)}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function ImageBlock({ props }: BlockProps<Record<string, unknown>, MagazineThemeSettings>) {
  const src = str(props.src ?? props.url);
  if (!src) return null;

  return (
    <figure className="zmag__figure">
      <img src={src} alt={str(props.alt)} loading="lazy" />
      {props.caption ? <figcaption>{str(props.caption)}</figcaption> : null}
    </figure>
  );
}

/**
 * `core/content-list` — a list an EDITOR placed, rather than one the theme declared.
 *
 * Its props are a query ("six posts, newest first"), and cms-api has already run it:
 * the rows arrive resolved in `props.items`. So it is set exactly as the front page's
 * river is set, from exactly the same kind of row — a grid gets the river's columns, a
 * list gets the section front's stacked rules — and neither of them needs to know that
 * a database was involved.
 */
function ContentListBlock({
  props,
  ctx,
}: BlockProps<Record<string, unknown>, MagazineThemeSettings>) {
  const items = list(props.items);
  const grid = str(props.layout, "list") === "grid";

  return (
    <section className="zmag__block-list">
      {props.heading ? (
        <h2 className="zmag__band-title">
          <span>{str(props.heading)}</span>
        </h2>
      ) : null}

      {items.length === 0 ? (
        <p className="zmag__empty">{ctx.t("latest.empty")}</p>
      ) : (
        <div className={grid ? "zmag__river" : "zmag__block-river"}>
          {items.map((item, index) => {
            const path = str(item.path);
            const title = str(item.title);
            const kicker = [field(item.data, "category"), field(item.data, "kicker")]
              .filter(Boolean)
              .join(" · ");

            return (
              <article className="zmag__river-item" key={str(item.id, String(index))}>
                <p className="zmag__kicker">{kicker || ctx.t("post.kicker")}</p>
                <h3>{path ? <a href={ctx.url(path)}>{title}</a> : title}</h3>
                {item.excerpt ? <p>{str(item.excerpt)}</p> : null}
                <p className="zmag__byline">
                  {formatDate(
                    typeof item.publishedAt === "string" ? item.publishedAt : null,
                    ctx.locale,
                  )}
                </p>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function CtaBlock({ props }: BlockProps<Record<string, unknown>, MagazineThemeSettings>) {
  return (
    <section className="zmag__block-cta">
      <h2>{str(props.heading)}</h2>
      {props.body ? <p>{str(props.body)}</p> : null}
      {props.ctaLabel && props.ctaHref ? (
        <a className="zmag__btn" href={str(props.ctaHref)}>
          {str(props.ctaLabel)}
        </a>
      ) : null}
    </section>
  );
}

// ------------------------------------------------------------------------ theme

const theme = defineTheme<MagazineThemeSettings>({
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
        // The same order the Layout uses for `--z-accent`: this theme's setting, then
        // the site's brand. The address bar and the masthead must not disagree about
        // what colour the paper is.
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
