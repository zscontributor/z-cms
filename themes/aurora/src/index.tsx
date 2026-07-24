import type {
  ArchiveTemplateProps,
  BlockProps,
  ErrorTemplateProps,
  LayoutProps,
  NotFoundTemplateProps,
  PageTemplateProps,
  Theme,
  ThemeManifest,
} from "@zcmsorg/theme-sdk";
import manifestJson from "../theme.json";
import en from "./locales/en.json";
import ja from "./locales/ja.json";
import vi from "./locales/vi.json";

/**
 * Aurora — the second theme, and the reason it exists.
 *
 * A theme SDK with one implementation is not a contract, it is a description of
 * that implementation. Aurora is deliberately unlike the default theme — dark,
 * editorial, plain CSS instead of Tailwind, its own settings keys — because the
 * only way to find out whether the contract leaks is to build against it twice.
 *
 * It imports nothing from Z-CMS except `@zcmsorg/theme-sdk`. No database, no API,
 * no Next.js. That is the whole point: it is a package, and it is installed, not
 * deployed.
 */

interface AuroraSettings {
  accent: string;
  siteTitle: string;
  tagline: string;
  footerText: string;
}

const manifest = manifestJson as unknown as ThemeManifest;

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function Layout({ ctx, children }: LayoutProps<AuroraSettings>) {
  const { settings, menus } = ctx;
  const primary = menus.primary?.items ?? [];
  const footer = menus.footer?.items ?? [];

  return (
    <div
      className="aurora"
      // The accent arrives as data, never hardcoded — a theme that baked in its
      // brand colour could not be re-skinned by the site owner. Aurora's own
      // setting wins when it is filled in; blank falls through to the SITE's brand
      // colour, which belongs to the site and outlives any one theme.
      style={{ ["--accent" as string]: settings.accent || ctx.site.brand.primaryColor }}
    >
      <header className="aurora__header">
        <div className="aurora__wrap aurora__bar">
          <a href={ctx.url("/")} className="aurora__brand" aria-label={settings.siteTitle}>
            {/* The site's logo if it has one; otherwise Aurora's wordmark-as-text.
                Aurora ships no logo of its own — most themes will not — and this is
                exactly the case `ctx.site.brand` exists for. */}
            {ctx.site.brand.logo ? (
              <img
                className="aurora__brand-logo"
                src={ctx.site.brand.logo}
                alt=""
              />
            ) : (
              <span className="aurora__brand-name">
                {settings.siteTitle}
                <em>.</em>
              </span>
            )}
            {settings.tagline ? (
              <span className="aurora__tagline">{settings.tagline}</span>
            ) : null}
          </a>

          {primary.length > 0 ? (
            <nav className="aurora__nav" aria-label={ctx.t("nav.primary")}>
              {primary.map((item) => (
                <a key={item.id} href={item.url} target={item.target}>
                  {item.label}
                </a>
              ))}
            </nav>
          ) : null}
        </div>
      </header>

      <main className="aurora__main">
        <div className="aurora__wrap">{children}</div>
      </main>

      <footer className="aurora__footer">
        <div
          className="aurora__wrap"
          style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}
        >
          <span>{settings.footerText}</span>
          {footer.length > 0 ? (
            <nav className="aurora__nav" aria-label={ctx.t("nav.footer")}>
              {footer.map((item) => (
                <a key={item.id} href={item.url} target={item.target}>
                  {item.label}
                </a>
              ))}
            </nav>
          ) : null}
        </div>
      </footer>
      {ctx.renderSlot("floating")}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function Page({ ctx, content }: PageTemplateProps<AuroraSettings>) {
  return (
    <article>
      <h1 className="aurora__title">{content.title}</h1>
      {content.excerpt ? <p className="aurora__lede">{content.excerpt}</p> : null}
      <div className="aurora__prose">{ctx.renderBlocks(content.blocks)}</div>
    </article>
  );
}

function Home({ ctx, content }: PageTemplateProps<AuroraSettings>) {
  return (
    <article>
      <p className="aurora__eyebrow">{ctx.settings.siteTitle}</p>
      <div className="aurora__prose">{ctx.renderBlocks(content.blocks)}</div>
    </article>
  );
}

function formatDate(iso: string | null, locale: string): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(locale, {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function Post({ ctx, content }: PageTemplateProps<AuroraSettings>) {
  return (
    <article>
      <p className="aurora__eyebrow">
        {formatDate(content.publishedAt, ctx.locale)}
        {content.author ? ` · ${content.author.name}` : ""}
      </p>
      <h1 className="aurora__title">{content.title}</h1>
      {content.excerpt ? <p className="aurora__lede">{content.excerpt}</p> : null}
      <hr className="aurora__rule" />
      <div className="aurora__prose">{ctx.renderBlocks(content.blocks)}</div>
    </article>
  );
}

function Archive({ ctx, archive }: ArchiveTemplateProps<AuroraSettings>) {
  return (
    <section>
      <h1 className="aurora__title">{archive.title}</h1>

      {archive.items.length === 0 ? (
        <p className="aurora__lede">{ctx.t("archive.empty")}</p>
      ) : (
        <ul className="aurora__list">
          {archive.items.map((item) => (
            <li key={item.id} className="aurora__item">
              <p className="aurora__meta">{formatDate(item.publishedAt, ctx.locale)}</p>
              <h2>
                <a href={ctx.url(item.path)}>{item.title}</a>
              </h2>
              {item.excerpt ? <p>{item.excerpt}</p> : null}
            </li>
          ))}
        </ul>
      )}

      {archive.totalPages > 1 ? (
        <p className="aurora__meta" style={{ marginTop: 32 }}>
          {archive.page > 1 ? (
            <a href={`${archive.basePath}?page=${archive.page - 1}`}>
              ← {ctx.t("archive.previous")}
            </a>
          ) : null}{" "}
          {ctx.t("archive.pageOf", { page: archive.page, total: archive.totalPages })}{" "}
          {archive.page < archive.totalPages ? (
            <a href={`${archive.basePath}?page=${archive.page + 1}`}>
              {ctx.t("archive.next")} →
            </a>
          ) : null}
        </p>
      ) : null}
    </section>
  );
}

function NotFound({ ctx }: NotFoundTemplateProps<AuroraSettings>) {
  return (
    <section>
      <p className="aurora__eyebrow">404</p>
      <h1 className="aurora__title">{ctx.t("notFound.title")}</h1>
      <p className="aurora__lede">{ctx.t("notFound.description")}</p>
      <a className="aurora__cta" href={ctx.url("/")}>
        {ctx.t("notFound.backHome")}
      </a>
    </section>
  );
}

function ErrorPage({
  ctx,
  statusCode,
  title,
  message,
  digest,
}: ErrorTemplateProps<AuroraSettings>) {
  return (
    <section>
      <p className="aurora__eyebrow">{statusCode}</p>
      <h1 className="aurora__title">{title || ctx.t("error.title")}</h1>
      <p className="aurora__lede">{message || ctx.t("error.description")}</p>
      {digest ? <p className="aurora__meta">{ctx.t("error.reference")}: {digest}</p> : null}
      <a className="aurora__cta" href={ctx.url("/")}>
        {ctx.t("error.backHome")}
      </a>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Blocks — the same five core types the default theme draws, drawn differently.
// ---------------------------------------------------------------------------

const str = (v: unknown, fallback = ""): string =>
  typeof v === "string" ? v : fallback;

function Hero({ props }: BlockProps<Record<string, unknown>, AuroraSettings>) {
  return (
    <section className="aurora__hero">
      <h1 className="aurora__title">{str(props.heading)}</h1>
      {props.subheading ? (
        <p className="aurora__lede">{str(props.subheading)}</p>
      ) : null}
      {props.ctaLabel && props.ctaHref ? (
        <a className="aurora__cta" href={str(props.ctaHref)}>
          {str(props.ctaLabel)}
        </a>
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
function RichText({ props }: BlockProps<Record<string, unknown>, AuroraSettings>) {
  return (
    <div
      className="aurora__prose"
      dangerouslySetInnerHTML={{ __html: str(props.html) }}
    />
  );
}

function Features({ props }: BlockProps<Record<string, unknown>, AuroraSettings>) {
  const items = Array.isArray(props.items)
    ? (props.items as { title?: string; body?: string }[])
    : [];

  return (
    <section className="aurora__features">
      {props.heading ? <h2>{str(props.heading)}</h2> : null}
      {items.map((item, i) => (
        <div className="aurora__feature" key={i}>
          <span className="aurora__feature-num">{String(i + 1).padStart(2, "0")}</span>
          <div>
            <h3>{str(item.title)}</h3>
            <p>{str(item.body)}</p>
          </div>
        </div>
      ))}
    </section>
  );
}

function ImageBlock({ props }: BlockProps<Record<string, unknown>, AuroraSettings>) {
  const src = str(props.src ?? props.url);
  if (!src) return null;

  return (
    <figure className="aurora__figure">
      <img src={src} alt={str(props.alt)} loading="lazy" />
      {props.caption ? <figcaption>{str(props.caption)}</figcaption> : null}
    </figure>
  );
}

function Cta({ props }: BlockProps<Record<string, unknown>, AuroraSettings>) {
  return (
    <section className="aurora__hero">
      <h2 className="aurora__title" style={{ fontSize: 28 }}>
        {str(props.heading)}
      </h2>
      {props.body ? <p className="aurora__lede">{str(props.body)}</p> : null}
      {props.ctaLabel && props.ctaHref ? (
        <a className="aurora__cta" href={str(props.ctaHref)}>
          {str(props.ctaLabel)}
        </a>
      ) : null}
    </section>
  );
}

const theme: Theme<AuroraSettings> = {
  manifest,
  Layout,
  templates: {
    home: Home,
    page: Page,
    post: Post,
    archive: Archive,
    notFound: NotFound,
    error: ErrorPage,
  },
  blocks: {
    "core/hero": Hero,
    "core/richtext": RichText,
    "core/features": Features,
    "core/image": ImageBlock,
    "core/cta": Cta,
  },
  // Aurora's strings belong to Aurora, not to core: a theme is installed and
  // removed on its own schedule, so its catalogue travels inside its package.
  // English is the base — a locale nobody has translated Aurora into still renders.
  messages: { en, ja, vi },
  // Settings -> document head. The site owner renames the site in the admin and
  // the <title> follows, with no change to core and no change to this theme.
  seo: (ctx) => ({
    titleTemplate: `%s · ${ctx.settings.siteTitle}`,
    description: ctx.settings.tagline,
    // Same order as the layout's --accent, so the address bar and the page agree.
    icons: { themeColor: ctx.settings.accent || ctx.site.brand.primaryColor },
  }),
};

export default theme;
