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
 * Z Market — a storefront for a cosmetics brand: soft paper, a rose accent,
 * hairline rules and a lot of air.
 *
 * It talks to the Theme SDK and to nothing else. Templates receive a ThemeContext
 * and a ContentDto, and that is the whole of their view of the platform — nothing
 * here knows about Next.js, Prisma or cms-api.
 *
 * It renders on the SERVER, and ships no client JavaScript. The three things in a
 * shop that usually reach for it do not here:
 *
 *   - the language switcher is a native <details> disclosure over `ctx.alternates`,
 *   - the dark/light toggle is the SDK's own <ColorModeToggle>, which the runtime
 *     wires up: this theme declares in its manifest that it is drawn for both modes,
 *     says where the switch goes, and styles itself under html[data-theme="dark"].
 *     It never touches an event, a store, or an icon.
 *   - the product accordions are <details>, and the newsletter is a GET form.
 *
 * There is no cart, because a cart is JavaScript. "Add to bag" is a link to
 * `settings.shopUrl` — whatever the shop actually is, on this site or elsewhere.
 *
 * A shop with no photographs is a hard brief, so the product and category imagery
 * is DRAWN: gradients, radii and shadows composed into a bottle, a jar and a stick.
 * See `.zmarket__art` in src/theme.css.
 */

export interface MarketThemeSettings {
  primaryColor: string;
  siteTitle: string;
  logo: string;
  tagline: string;
  metaDescription: string;
  announcement: string;
  shopUrl: string;
  currency: string;
  showSearch: boolean;
  footerText: string;
  ogImage: string;
  favicon: string;
  twitterSite: string;
  noindex: boolean;
  organizationName: string;
  organizationUrl: string;
  socialProfiles: string;
}

type Ctx = ThemeContext<MarketThemeSettings>;

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

/** A content type's custom fields are `data`, which is untyped for the same reason. */
function num(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
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

/**
 * A price is a number and a currency, and only Intl knows how the reader's language
 * writes the pair — "$48.00", "¥48", "48,00 $US". The currency is a *setting*, so a
 * shop that sells in yen is one field away, not one fork away.
 */
function formatPrice(value: number, locale: string, currency: string): string {
  const code = (currency || "USD").trim().toUpperCase();
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: code }).format(
      value,
    );
  } catch {
    // An invalid code typed into the settings form must not take the shop down.
    return `${value} ${code}`;
  }
}

/** Absolute URLs go to another site untouched; site-relative ones get the locale prefix. */
function itemHref(ctx: Ctx, item: MenuItemDto): string {
  return /^[a-z]+:\/\//i.test(item.url) || item.url.startsWith("#")
    ? item.url
    : ctx.url(item.url);
}

/** The shop can live on this site ("/shop") or on another one ("https://…"). */
function shopHref(ctx: Ctx): string {
  const target = ctx.settings.shopUrl || "/shop";
  return /^[a-z]+:\/\//i.test(target) ? target : ctx.url(target);
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
    <details className="zmarket__lang">
      <summary aria-label={ctx.t("language.switch")}>
        <span aria-hidden="true">🌐</span>
        <span>{current.locale}</span>
      </summary>
      <ul className="zmarket__lang-menu">
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
                  className="zmarket__lang-flag"
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
    <nav className="zmarket__links" aria-label={menu?.name ?? ctx.t("nav.primary")}>
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

/**
 * The same menu again, as a <details> disclosure, for the width at which the
 * horizontal one is hidden. Native HTML: a burger menu is only JavaScript because
 * somebody decided it had to be.
 */
function MobileNav({ ctx, menu }: { ctx: Ctx; menu?: MenuDto }) {
  const items = menu?.items ?? [];
  if (items.length === 0) return null;

  return (
    <details className="zmarket__burger">
      <summary aria-label={ctx.t("nav.menu")}>
        <span aria-hidden="true">☰</span>
      </summary>
      <nav className="zmarket__burger-menu" aria-label={menu?.name ?? ctx.t("nav.primary")}>
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
    </details>
  );
}

/** Plain GET form: search is a URL, not an app. */
function SearchBox({ ctx }: { ctx: Ctx }) {
  return (
    <form className="zmarket__search" role="search" action={ctx.url("/search")} method="get">
      <label className="zmarket__skip" htmlFor="zmarket-q">
        {ctx.t("search.label")}
      </label>
      <input id="zmarket-q" type="search" name="q" placeholder={ctx.t("search.placeholder")} />
    </form>
  );
}

// ---------------------------------------------------------------------- layout

function Layout({ ctx, children }: LayoutProps<MarketThemeSettings>) {
  const { settings, site, menus } = ctx;

  // Three sources, most specific first, and the order is the point of a site-level
  // brand: this theme's setting (a tweak that applies only while this theme is
  // active), then the SITE's brand (which survives a theme change), then what the
  // theme ships.
  const brandStyle = {
    "--zm-rose": settings.primaryColor || site.brand.primaryColor || "#c2185b",
  } as CSSProperties;

  const title = settings.siteTitle || site.name;
  const logo = settings.logo || site.brand.logo;
  const footerMenu = menus.footer;
  const shop = shopHref(ctx);

  return (
    <div className="zmarket" style={brandStyle}>
      <a className="zmarket__skip" href="#main">
        {ctx.t("layout.skipToContent")}
      </a>

      {settings.announcement ? (
        <div className="zmarket__announce">
          <span>{settings.announcement}</span>{" "}
          <a href={shop}>{ctx.t("topbar.link")} →</a>
        </div>
      ) : null}

      <header className="zmarket__header">
        <div className="zmarket__container zmarket__nav">
          <div className="zmarket__nav-left">
            <MobileNav ctx={ctx} menu={menus.primary} />
            <PrimaryNav ctx={ctx} menu={menus.primary} />
          </div>

          {/* The wordmark sits in the middle, the way a beauty masthead does. */}
          <a className="zmarket__brand" href={ctx.url("/")} aria-label={title}>
            {logo ? (
              // Empty alt, and the link carries the label: the logo IS the shop name
              // here, so describing it again makes a screen reader say it twice.
              <img className="zmarket__brand-logo" src={ctx.asset(logo)} alt="" />
            ) : (
              <span className="zmarket__wordmark">{title}</span>
            )}
          </a>

          <div className="zmarket__actions">
            {settings.showSearch ? <SearchBox ctx={ctx} /> : null}
            <LanguageSwitcher ctx={ctx} />
            {/* The SDK's switch, not the theme's: the runtime wires up the click, the
                persistence and the icon swap. It renders nothing at all on a theme that
                declares a single colour mode, so a theme cannot ship a dead button. */}
            <ColorModeToggle ctx={ctx} className="zmarket__icon-btn" />
            <a className="zmarket__bag" href={shop}>
              <span aria-hidden="true">◇</span>
              <span>{ctx.t("nav.cart")}</span>
            </a>
          </div>
        </div>
      </header>

      <main id="main">{children}</main>

      <footer className="zmarket__footer">
        <div className="zmarket__container zmarket__footer-grid">
          <div className="zmarket__footer-brand">
            <span className="zmarket__wordmark">{title}</span>
            <p>{settings.metaDescription || settings.tagline}</p>
          </div>

          <div>
            <h4>{ctx.t("footer.shop")}</h4>
            <ul>
              <li>
                <a href={shop}>{ctx.t("footer.newArrivals")}</a>
              </li>
              <li>
                <a href={shop}>{ctx.t("footer.bestsellers")}</a>
              </li>
              <li>
                <a href={shop}>{ctx.t("footer.giftSets")}</a>
              </li>
              <li>
                <a href={shop}>{ctx.t("footer.refills")}</a>
              </li>
            </ul>
          </div>

          <div>
            <h4>{ctx.t("footer.brand")}</h4>
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
                    <a href={ctx.url("/about")}>{ctx.t("footer.ourStory")}</a>
                  </li>
                  <li>
                    <a href={ctx.url("/journal")}>{ctx.t("footer.journal")}</a>
                  </li>
                  <li>
                    <a href={ctx.url("/about")}>{ctx.t("footer.ingredients")}</a>
                  </li>
                  <li>
                    <a href={ctx.url("/about")}>{ctx.t("footer.sustainability")}</a>
                  </li>
                </>
              )}
            </ul>
          </div>

          <div>
            <h4>{ctx.t("footer.help")}</h4>
            <ul>
              <li>
                <a href={ctx.url("/shipping")}>{ctx.t("footer.shipping")}</a>
              </li>
              <li>
                <a href={ctx.url("/returns")}>{ctx.t("footer.returns")}</a>
              </li>
              <li>
                <a href={ctx.url("/faq")}>{ctx.t("footer.faq")}</a>
              </li>
              <li>
                <a href={ctx.url("/contact")}>{ctx.t("footer.contact")}</a>
              </li>
            </ul>
          </div>

          <div>
            <h4>{ctx.t("footer.follow")}</h4>
            <ul>
              {(parseLines(settings.socialProfiles) ?? []).length > 0 ? (
                parseLines(settings.socialProfiles)!.map((href) => (
                  <li key={href}>
                    <a href={href} target="_blank" rel="noopener noreferrer">
                      {href.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "")}
                    </a>
                  </li>
                ))
              ) : (
                <li>
                  <a
                    href={settings.organizationUrl || "https://z-soft.com.vn"}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {settings.organizationName || "Z-SOFT"}
                  </a>
                </li>
              )}
            </ul>
          </div>
        </div>

        <div className="zmarket__container zmarket__footer-bottom">
          <span>{settings.footerText}</span>
          <span>{settings.tagline}</span>
        </div>
      </footer>

      {/* Fixed, so it is reachable from anywhere on a long storefront. The
          scroll-to-top is an anchor rather than a button: "go back to the top" is a
          link to the top, and HTML has had that since 1993. */}
      <a
        className="zmarket__totop"
        href="#main"
        aria-label={ctx.t("layout.backToTop")}
        title={ctx.t("layout.backToTop")}
      >
        <span aria-hidden="true">↑</span>
      </a>
      {ctx.renderSlot("floating")}
    </div>
  );
}

// ------------------------------------------------------- drawn product imagery

/**
 * A cosmetics shop with no photographs.
 *
 * The theme cannot ship product shots — it does not know what the shop sells — and
 * a grey rectangle saying "image" is not a design. So the bottle, the jar and the
 * stick below are DRAWN: a few nested divs, a gradient for the glass, an ellipse
 * for the shoulder, a soft shadow for the surface it stands on. They read as
 * intentional at every size, they re-colour in dark mode with the rest of the
 * palette, and they cost nothing to download.
 *
 * `role="img"` with a label, because that is what they are to a screen reader.
 */
type ArtShape = "bottle" | "jar" | "stick";
type ArtTone = "one" | "two" | "three" | "four";

function ProductArt({
  shape,
  tone,
  label,
}: {
  shape: ArtShape;
  tone: ArtTone;
  label: string;
}) {
  return (
    <div
      className={`zmarket__art zmarket__art--${tone}`}
      role="img"
      aria-label={label}
    >
      <div className={`zmarket__vessel zmarket__vessel--${shape}`} aria-hidden="true">
        <i className="zmarket__vessel-cap" />
        <i className="zmarket__vessel-body">
          <b />
        </i>
      </div>
      <span className="zmarket__art-floor" aria-hidden="true" />
    </div>
  );
}

/**
 * Which vessel a product is drawn as, and in which tint.
 *
 * Rotated by position rather than chosen per product: the theme has no idea whether
 * row three is a balm or a cleanser, and a shop's own product data is not going to
 * carry a field called "shape" for the benefit of one theme. The same product in the
 * same list therefore draws the same vessel on every render — which is what stops the
 * grid from reshuffling itself on a refresh — without the theme pretending to know
 * something about the catalogue that it does not.
 */
const PRODUCT_SHAPES: ArtShape[] = ["bottle", "jar", "stick"];
const PRODUCT_TONES: ArtTone[] = ["one", "two", "three", "four"];

// ------------------------------------------------------------------- templates

const CATEGORIES = [
  { key: "one", tone: "one", shape: "bottle" },
  { key: "two", tone: "three", shape: "stick" },
  { key: "three", tone: "two", shape: "jar" },
  { key: "four", tone: "four", shape: "bottle" },
] as const;

const VALUE_ICONS = ["✿", "◍", "↻", "✓"];

/**
 * The storefront: announcement, hero, categories, the edit, the promises, a press
 * quote, the journal, the letter.
 *
 * The LAYOUT is the theme's — where the grid sits, what a card looks like, how a
 * bottle is drawn. What the grid CONTAINS is the shop's: `featured` and `journal` are
 * declared in theme.json, run by cms-api against this site's own database, and arrive
 * on `ctx.collections`. Adding a product in the admin puts it on the front page; this
 * file never learns that a database exists.
 *
 * The chrome that remains hardcoded — the category tiles, the four promises, the press
 * quote — is not content: nobody expects to find "Cruelty-free" in the content list of
 * their admin. The test is whether a site owner would go looking for it there.
 */
function HomeTemplate({ ctx, content }: PageTemplateProps<MarketThemeSettings>) {
  const { settings, locale } = ctx;
  const shop = shopHref(ctx);
  const currency = settings.currency || "USD";
  const featured = ctx.collections.featured ?? [];
  const journal = ctx.collections.journal ?? [];

  return (
    <>
      <section className="zmarket__hero">
        <div className="zmarket__container zmarket__hero-grid">
          <div className="zmarket__hero-copy">
            <p className="zmarket__eyebrow">{ctx.t("hero.eyebrow")}</p>
            <h1 className="zmarket__hero-title">
              {ctx.t("hero.title.first")}
              <br />
              <em>{ctx.t("hero.title.second")}</em>
            </h1>
            <p className="zmarket__lede">{ctx.t("hero.copy")}</p>

            <div className="zmarket__hero-actions">
              <a className="zmarket__btn zmarket__btn--rose" href={shop}>
                {ctx.t("hero.primary")}
              </a>
              <a className="zmarket__btn" href={ctx.url("/about")}>
                {ctx.t("hero.secondary")}
              </a>
            </div>

            <p className="zmarket__hero-note">{ctx.t("hero.note")}</p>
          </div>

          <ProductArt shape="bottle" tone="one" label={ctx.t("hero.aria")} />
        </div>
      </section>

      <section className="zmarket__section zmarket__cats">
        <div className="zmarket__container">
          <div className="zmarket__section-head">
            <div>
              <p className="zmarket__eyebrow">{ctx.t("categories.eyebrow")}</p>
              <h2 className="zmarket__section-title">{ctx.t("categories.title")}</h2>
            </div>
          </div>

          <div className="zmarket__cat-grid">
            {CATEGORIES.map((cat) => (
              <a
                className={`zmarket__cat zmarket__cat--${cat.tone}`}
                href={shop}
                key={cat.key}
              >
                <span className="zmarket__cat-art" aria-hidden="true">
                  <i className={`zmarket__vessel zmarket__vessel--${cat.shape}`}>
                    <i className="zmarket__vessel-cap" />
                    <i className="zmarket__vessel-body">
                      <b />
                    </i>
                  </i>
                </span>
                <span className="zmarket__cat-body">
                  <strong>{ctx.t(`categories.${cat.key}`)}</strong>
                  <span>{ctx.t("categories.link")} →</span>
                </span>
              </a>
            ))}
          </div>
        </div>
      </section>

      <section className="zmarket__section">
        <div className="zmarket__container">
          <div className="zmarket__section-head">
            <div>
              <p className="zmarket__eyebrow">{ctx.t("products.eyebrow")}</p>
              <h2 className="zmarket__section-title">{ctx.t("products.title")}</h2>
            </div>
            <p className="zmarket__section-copy">{ctx.t("products.copy")}</p>
          </div>

          {/* The shop's own products. An empty shelf is a normal state on a new site
              — the day the theme is installed, nobody has added a product yet — and it
              says so out loud, because a grid that renders nothing at all is
              indistinguishable from a broken one. */}
          {featured.length === 0 ? (
            <p className="zmarket__empty">{ctx.t("products.empty")}</p>
          ) : (
            <div className="zmarket__grid">
              {featured.map((product, index) => (
                <ProductCard
                  key={product.id}
                  ctx={ctx}
                  item={product}
                  currency={currency}
                  index={index}
                />
              ))}
            </div>
          )}

          <p className="zmarket__grid-more">
            <a className="zmarket__btn" href={shop}>
              {ctx.t("products.viewAll")}
            </a>
          </p>
        </div>
      </section>

      {/* The journal: the shop's own posts, newest first. */}
      <section className="zmarket__section zmarket__journal">
        <div className="zmarket__container">
          <div className="zmarket__section-head">
            <div>
              <p className="zmarket__eyebrow">{ctx.t("journal.eyebrow")}</p>
              <h2 className="zmarket__section-title">{ctx.t("journal.title")}</h2>
            </div>
            <a className="zmarket__btn" href={ctx.url("/journal")}>
              {ctx.t("journal.all")}
            </a>
          </div>

          {journal.length === 0 ? (
            <p className="zmarket__empty">{ctx.t("journal.empty")}</p>
          ) : (
            <ul className="zmarket__journal-grid">
              {journal.map((post) => (
                <li className="zmarket__journal-card" key={post.id}>
                  <p className="zmarket__meta">{formatDate(post.publishedAt, locale)}</p>
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

      <section className="zmarket__values">
        <div className="zmarket__container">
          <p className="zmarket__eyebrow">{ctx.t("values.eyebrow")}</p>
          <h2 className="zmarket__section-title">{ctx.t("values.title")}</h2>

          <div className="zmarket__value-grid">
            {["one", "two", "three", "four"].map((key, index) => (
              <article className="zmarket__value" key={key}>
                <span className="zmarket__value-icon" aria-hidden="true">
                  {VALUE_ICONS[index]}
                </span>
                <h3>{ctx.t(`values.${key}.title`)}</h3>
                <p>{ctx.t(`values.${key}.copy`)}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="zmarket__section">
        <div className="zmarket__container zmarket__quote">
          <p className="zmarket__eyebrow">{ctx.t("quote.eyebrow")}</p>
          <blockquote>
            <p>{ctx.t("quote.text")}</p>
            <footer>
              <strong>{ctx.t("quote.author")}</strong>
              <span>{ctx.t("quote.source")}</span>
            </footer>
          </blockquote>
        </div>
      </section>

      {/* Whatever the editor actually put on the home page in the CMS. The storefront
          sections above are the theme's opinion; this is the site's content. */}
      {content.blocks.length > 0 ? (
        <section className="zmarket__section" id="content">
          <div className="zmarket__container zmarket__narrow zmarket__prose">
            {ctx.renderBlocks(content.blocks)}
          </div>
        </section>
      ) : null}

      <NewsletterBand ctx={ctx} />
    </>
  );
}

/**
 * A GET form, posting to whatever the shop is. No fetch, no state, no validation
 * in JavaScript — `type="email" required` is validation, and the browser has done
 * it for a decade.
 */
function NewsletterBand({ ctx }: { ctx: Ctx }) {
  return (
    <section className="zmarket__letter">
      <div className="zmarket__container zmarket__letter-box">
        <div>
          <p className="zmarket__eyebrow">{ctx.t("newsletter.eyebrow")}</p>
          <h2>{ctx.t("newsletter.title")}</h2>
          <p className="zmarket__section-copy">{ctx.t("newsletter.copy")}</p>
        </div>

        <form className="zmarket__letter-form" method="get" action={ctx.url("/subscribe")}>
          <label className="zmarket__skip" htmlFor="zmarket-email">
            {ctx.t("newsletter.label")}
          </label>
          <input
            id="zmarket-email"
            type="email"
            name="email"
            required
            placeholder={ctx.t("newsletter.placeholder")}
          />
          <button className="zmarket__btn zmarket__btn--rose" type="submit">
            {ctx.t("newsletter.button")}
          </button>
          <p className="zmarket__letter-note">{ctx.t("newsletter.note")}</p>
        </form>
      </div>
    </section>
  );
}

/**
 * The product page.
 *
 * A `product` content type has no template of its own — the runtime falls back to
 * `page` for anything that is not a post or the home page — so `page` is where a
 * product is drawn, and it branches on the content type key. That is deliberate:
 * a site whose products are called something else still renders, as a page.
 */
function PageTemplate(props: PageTemplateProps<MarketThemeSettings>) {
  return props.content.contentType.key === "product" ? (
    <ProductView {...props} />
  ) : (
    <PlainPage {...props} />
  );
}

function PlainPage({ ctx, content }: PageTemplateProps<MarketThemeSettings>) {
  return (
    <article className="zmarket__article">
      <div className="zmarket__container zmarket__narrow">
        <p className="zmarket__eyebrow">{ctx.settings.siteTitle || ctx.site.name}</p>
        <h1 className="zmarket__article-title">{content.title}</h1>
        {content.excerpt ? <p className="zmarket__lede">{content.excerpt}</p> : null}
        <div className="zmarket__rule" />
        <div className="zmarket__prose">{ctx.renderBlocks(content.blocks)}</div>
      </div>
    </article>
  );
}

function ProductView({ ctx, content }: PageTemplateProps<MarketThemeSettings>) {
  const { locale, settings } = ctx;
  const data = content.data as Record<string, unknown>;

  const price = num(data.price);
  const oldPrice = num(data.oldPrice);
  const badge = str(data.badge);
  const volume = str(data.volume);
  const currency = settings.currency || "USD";

  return (
    <article className="zmarket__product">
      <div className="zmarket__container">
        <p className="zmarket__meta">
          <a href={shopHref(ctx)}>← {ctx.t("product.back")}</a>
        </p>

        <div className="zmarket__product-grid">
          <div className="zmarket__product-art">
            <ProductArt shape="bottle" tone="one" label={ctx.t("product.aria")} />
            {badge ? <span className="zmarket__badge">{badge}</span> : null}
          </div>

          <div className="zmarket__product-info">
            <h1 className="zmarket__product-title">{content.title}</h1>
            {volume ? <p className="zmarket__volume">{volume}</p> : null}

            {price !== null ? (
              <p className="zmarket__price zmarket__price--lg">
                <strong>{formatPrice(price, locale, currency)}</strong>
                {oldPrice !== null && oldPrice > price ? (
                  <s>
                    <span className="zmarket__skip">{ctx.t("product.oldPriceLabel")}</span>
                    {formatPrice(oldPrice, locale, currency)}
                  </s>
                ) : null}
              </p>
            ) : null}

            {content.excerpt ? <p className="zmarket__lede">{content.excerpt}</p> : null}

            {/* No cart, because a cart is JavaScript. This is a link to the shop. */}
            <a
              className="zmarket__btn zmarket__btn--rose zmarket__btn--block"
              href={shopHref(ctx)}
            >
              {ctx.t("product.addToCart")}
            </a>

            <div className="zmarket__accordion">
              {["ingredients", "howToUse", "shipping"].map((key) => (
                <details key={key}>
                  <summary>
                    <span>{ctx.t(`product.details.${key}.title`)}</span>
                    <i aria-hidden="true" />
                  </summary>
                  <p>{ctx.t(`product.details.${key}.body`)}</p>
                </details>
              ))}
            </div>
          </div>
        </div>

        <div className="zmarket__narrow zmarket__prose zmarket__product-prose">
          {ctx.renderBlocks(content.blocks)}
        </div>
      </div>
    </article>
  );
}

function PostTemplate({ ctx, content }: PageTemplateProps<MarketThemeSettings>) {
  const readingTime = num((content.data as Record<string, unknown>)?.readingTime);

  return (
    <article className="zmarket__article">
      <div className="zmarket__container zmarket__narrow">
        <p className="zmarket__meta">
          <a href={ctx.url("/journal")}>← {ctx.t("post.backToPosts")}</a>
        </p>
        <h1 className="zmarket__article-title">{content.title}</h1>

        <p className="zmarket__meta">
          {[
            formatDate(content.publishedAt, ctx.locale),
            content.author?.name,
            readingTime && readingTime > 0
              ? ctx.t("post.readingTime", { minutes: readingTime })
              : "",
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>

        {content.excerpt ? <p className="zmarket__lede">{content.excerpt}</p> : null}
        <div className="zmarket__rule" />
        <div className="zmarket__prose">{ctx.renderBlocks(content.blocks)}</div>
      </div>
    </article>
  );
}

/** The product listing. An archive of anything else lands here too, and still reads. */
function ArchiveTemplate({ ctx, archive }: ArchiveTemplateProps<MarketThemeSettings>) {
  const currency = ctx.settings.currency || "USD";

  return (
    <section className="zmarket__article">
      <div className="zmarket__container">
        <div className="zmarket__archive-head">
          <p className="zmarket__eyebrow">{ctx.settings.siteTitle || ctx.site.name}</p>
          <h1 className="zmarket__article-title">{archive.title}</h1>
          <p className="zmarket__lede">{ctx.t("archive.intro")}</p>
        </div>

        {archive.items.length === 0 ? (
          <p className="zmarket__lede">{ctx.t("archive.empty")}</p>
        ) : (
          <div className="zmarket__grid">
            {archive.items.map((item, index) => (
              <ProductCard
                key={item.id}
                ctx={ctx}
                item={item}
                currency={currency}
                index={index}
              />
            ))}
          </div>
        )}

        {archive.totalPages > 1 ? (
          <div className="zmarket__pagination">
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

/**
 * One product, as a card. The same component on the front page and in the listing —
 * a featured product and a listed product are the same thing, and were drawn twice
 * only while the front page's three were invented in this file.
 *
 * Everything visible comes off the row: the title, and `data.price`, `data.oldPrice`,
 * `data.badge`, `data.volume` — the fields the `product` content type declares. A shop
 * that renames or omits one of them still renders, because `num`/`str` treat the whole
 * of `data` as the untyped JSON it is.
 */
function ProductCard({
  ctx,
  item,
  currency,
  index,
}: {
  ctx: Ctx;
  item: ContentDto;
  currency: string;
  index: number;
}) {
  const data = (item.data ?? {}) as Record<string, unknown>;
  const price = num(data.price);
  const oldPrice = num(data.oldPrice);
  const badge = str(data.badge);
  const volume = str(data.volume);
  const href = ctx.url(item.path || "/");

  const shape = PRODUCT_SHAPES[index % PRODUCT_SHAPES.length]!;
  const tone = PRODUCT_TONES[index % PRODUCT_TONES.length]!;

  return (
    <article className="zmarket__card">
      <a className="zmarket__card-art" href={href}>
        <ProductArt shape={shape} tone={tone} label={ctx.t("product.aria")} />
        {badge ? <span className="zmarket__badge">{badge}</span> : null}
      </a>
      <div className="zmarket__card-body">
        <h3>
          <a href={href}>{item.title}</a>
        </h3>
        {volume ? <p className="zmarket__volume">{volume}</p> : null}
        {price !== null ? (
          <p className="zmarket__price">
            <strong>{formatPrice(price, ctx.locale, currency)}</strong>
            {oldPrice !== null && oldPrice > price ? (
              <s>
                <span className="zmarket__skip">{ctx.t("product.oldPriceLabel")}</span>
                {formatPrice(oldPrice, ctx.locale, currency)}
              </s>
            ) : null}
          </p>
        ) : item.excerpt ? (
          <p className="zmarket__volume">{item.excerpt}</p>
        ) : null}
      </div>
    </article>
  );
}

function NotFoundTemplate({ ctx }: NotFoundTemplateProps<MarketThemeSettings>) {
  return (
    <section className="zmarket__article">
      <div className="zmarket__container zmarket__narrow zmarket__center">
        <p className="zmarket__eyebrow">404</p>
        <h1 className="zmarket__article-title">{ctx.t("notFound.title")}</h1>
        <p className="zmarket__lede">{ctx.t("notFound.description")}</p>
        <a className="zmarket__btn zmarket__btn--rose" href={shopHref(ctx)}>
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
}: ErrorTemplateProps<MarketThemeSettings>) {
  return (
    <section className="zmarket__article">
      <div className="zmarket__container zmarket__narrow zmarket__center">
        <p className="zmarket__eyebrow">{statusCode}</p>
        <h1 className="zmarket__article-title">{title || ctx.t("error.title")}</h1>
        <p className="zmarket__lede">{message || ctx.t("error.description")}</p>
        {/* The digest is the only thread between what the visitor saw and what the
            operator can find in the logs. Worth the ugly line of text. */}
        {digest ? (
          <p className="zmarket__meta">
            {ctx.t("error.reference")}: {digest}
          </p>
        ) : null}
        <a className="zmarket__btn zmarket__btn--rose" href={ctx.url("/")}>
          {ctx.t("error.backHome")}
        </a>
      </div>
    </section>
  );
}

// ----------------------------------------------------------------------- blocks

function HeroBlock({ props }: BlockProps<Record<string, unknown>, MarketThemeSettings>) {
  return (
    <section className="zmarket__block-hero">
      {props.eyebrow ? <p className="zmarket__eyebrow">{str(props.eyebrow)}</p> : null}
      <h2>{str(props.heading)}</h2>
      {props.subheading ? (
        <p className="zmarket__section-copy">{str(props.subheading)}</p>
      ) : null}
      {props.ctaLabel && props.ctaHref ? (
        <p className="zmarket__block-hero-cta">
          <a className="zmarket__btn zmarket__btn--rose" href={str(props.ctaHref)}>
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
function RichTextBlock({ props }: BlockProps<Record<string, unknown>, MarketThemeSettings>) {
  return <div dangerouslySetInnerHTML={{ __html: str(props.html) }} />;
}

function FeaturesBlock({ props }: BlockProps<Record<string, unknown>, MarketThemeSettings>) {
  const items = list(props.items);

  return (
    <section className="zmarket__block-section">
      {props.heading ? <h2>{str(props.heading)}</h2> : null}
      {props.subheading ? <p>{str(props.subheading)}</p> : null}
      <div className="zmarket__block-features">
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

function ImageBlock({ props }: BlockProps<Record<string, unknown>, MarketThemeSettings>) {
  const src = str(props.src ?? props.url);
  if (!src) return null;

  return (
    <figure className="zmarket__figure">
      <img src={src} alt={str(props.alt)} loading="lazy" />
      {props.caption ? <figcaption>{str(props.caption)}</figcaption> : null}
    </figure>
  );
}

/**
 * `core/content-list` — a list an EDITOR placed, rather than one the theme declared.
 *
 * Its props are a query ("three products, newest first"), and cms-api has already run
 * it: the rows arrive resolved in `props.items`. So it is drawn exactly like the front
 * page's shelves, from exactly the same kind of row, and neither of them needs to know
 * that a database was involved.
 *
 * `layout` is a hint, not a command. Here "grid" is the product shelf and "list" is the
 * journal river, and the theme decides what each looks like.
 */
function ContentListBlock({
  props,
  ctx,
}: BlockProps<Record<string, unknown>, MarketThemeSettings>) {
  const items = list(props.items);
  const grid = str(props.layout, "list") === "grid";
  const currency = ctx.settings.currency || "USD";

  return (
    <section className="zmarket__block-section">
      {props.heading ? <h2>{str(props.heading)}</h2> : null}

      {items.length === 0 ? (
        <p className="zmarket__empty">{ctx.t("list.empty")}</p>
      ) : grid ? (
        <div className="zmarket__grid">
          {items.map((item, index) => (
            <ProductCard
              key={str(item.id, String(index))}
              ctx={ctx}
              // Resolved rows are ContentDto, but they arrive through untyped block
              // props — so they are read through the same guards as everything else,
              // and the cast is only what re-attaches the shape those guards enforce.
              item={item as unknown as ContentDto}
              currency={currency}
              index={index}
            />
          ))}
        </div>
      ) : (
        <ul className="zmarket__journal-grid">
          {items.map((item, index) => {
            const path = str(item.path);
            const title = str(item.title);

            return (
              <li className="zmarket__journal-card" key={str(item.id, String(index))}>
                <p className="zmarket__meta">
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

function CtaBlock({ props }: BlockProps<Record<string, unknown>, MarketThemeSettings>) {
  return (
    <section className="zmarket__block-cta">
      <h2>{str(props.heading)}</h2>
      {props.body ? <p>{str(props.body)}</p> : null}
      {props.ctaLabel && props.ctaHref ? (
        <a className="zmarket__btn zmarket__btn--rose" href={str(props.ctaHref)}>
          {str(props.ctaLabel)}
        </a>
      ) : null}
    </section>
  );
}

// ------------------------------------------------------------------------ theme

const theme = defineTheme<MarketThemeSettings>({
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
  // keeps rendering on a shop in any language.
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
        // The same order the Layout uses for `--zm-rose`: this theme's setting, then
        // the site's brand. The address bar and the header must not disagree about
        // what colour the shop is.
        themeColor: s.primaryColor || ctx.site.brand.primaryColor || undefined,
      },

      organization: {
        name: s.organizationName || s.siteTitle || "",
        url: s.organizationUrl || undefined,
        logo: s.logo || undefined,
        sameAs: parseLines(s.socialProfiles),
      },
    };
  },
});

export default theme;
export { Layout };
