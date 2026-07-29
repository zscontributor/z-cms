import type { CSSProperties, ReactNode } from "react";
import type { ContentDto, MenuItemDto } from "@zcmsorg/schemas";
import { bindingToCollectionQuery, collectionNameFor } from "@zcmsorg/schemas";
import type { WidgetComponent, WidgetProps } from "./types";
import { boolProp, colorProp, numberProp, stringArrayProp, stringProp } from "./tokens";

/**
 * The widgets themselves.
 *
 * Every one is a pure function of (props, ctx) with no hooks and no state, because
 * a theme renders on the server and ships no client bundle. They are written once,
 * reviewed once, and then every theme anybody draws is these same components in a
 * different arrangement — which is the entire reason a non-programmer can publish
 * a theme without the platform shipping a stranger's code.
 *
 * A widget that cannot draw itself renders NOTHING (null), never a placeholder and
 * never a crash. A drawn theme lands on sites its author never saw: a menu location
 * that site does not define, a content type it does not have, a post template on a
 * page with no post. The honest response to "there is nothing here" is to render
 * nothing, and let the section around it collapse.
 */

const ALIGN_CLASS: Record<string, string> = {
  left: "zw-align-left",
  center: "zw-align-center",
  right: "zw-align-right",
};

function alignClass(props: Record<string, unknown>): string {
  return ALIGN_CLASS[stringProp(props, "align", "left")] ?? ALIGN_CLASS.left!;
}

/** Clamps a heading level to h1..h6 — a document is data, and data can be wrong. */
function headingTag(props: Record<string, unknown>, fallback: number): string {
  const level = Number(props.level ?? fallback);
  const safe = Number.isFinite(level) ? Math.min(6, Math.max(1, Math.trunc(level))) : fallback;
  return `h${safe}`;
}

export const Heading: WidgetComponent = ({ node }) => {
  const text = stringProp(node.props, "text");
  if (!text) return null;
  const Tag = headingTag(node.props, 2) as "h2";
  return <Tag className={`zw-heading ${alignClass(node.props)}`}>{text}</Tag>;
};

export const RichText: WidgetComponent = ({ node }) => {
  const html = stringProp(node.props, "html");
  if (!html) return null;
  // The HTML is sanitised on the way IN (cms-api's sanitize-blocks runs when the
  // draft is saved), exactly as a `core/richtext` block's is. Sanitising again here
  // would be a second policy to disagree with the first.
  return <div className="zw-richtext" dangerouslySetInnerHTML={{ __html: html }} />;
};

export const Button: WidgetComponent = ({ node, ctx }) => {
  const label = stringProp(node.props, "label");
  // A button is its label — that is the content. Without one there is nothing to
  // show, so it renders nothing; a link, though, is optional. A labelled button whose
  // link is not set yet still draws (as a non-link), so it is visible while laid out.
  if (!label) return null;
  const href = stringProp(node.props, "href");
  const variant = stringProp(node.props, "variant", "primary");
  const className = `zw-button zw-button-${variant}`;
  return (
    <div className={`zw-button-wrap ${alignClass(node.props)}`}>
      {href ? (
        <a className={className} href={ctx.url(href)}>
          {label}
        </a>
      ) : (
        <span className={className}>{label}</span>
      )}
    </div>
  );
};

/**
 * A contact form — the one interactive widget, and interactive without shipping any
 * theme JS.
 *
 * It renders a plain HTML `<form>` posting to `/api/contact/submit`, the endpoint the
 * runtime owns. That endpoint validates against CONTACT_FORM_FIELDS, mails the site's
 * configured recipient, and — for a browser with JS — the runtime's globally-injected
 * enhancer intercepts the submit, validates with the SAME shared rules, and reveals
 * the result without a navigation. With JS off, the endpoint 303s back to the form's
 * own `#…-sent` / `#…-error` anchor and the `.zw-form-note:target` CSS in widgets.css
 * shows the matching banner. Either way a drawn form works with no per-theme wiring.
 *
 * The field set (name/email/message) is a subset of CONTACT_FORM_FIELDS; the maxlengths
 * mirror it so the browser rejects what the server would. Every id is scoped to the
 * node (`zw-cf-<nodeId>-…`) so two forms on one page never collide: the enhancer reads
 * each form's `data-note-ok/err`, and the no-JS redirect targets the `_anchor` this
 * form posts. `name`/`email`/`message` (the submitted keys) stay fixed — the endpoint
 * reads those.
 */
export const ContactForm: WidgetComponent = ({ node }) => {
  const nameLabel = stringProp(node.props, "nameLabel", "Name");
  const emailLabel = stringProp(node.props, "emailLabel", "Email");
  const messageLabel = stringProp(node.props, "messageLabel", "Message");
  const submitLabel = stringProp(node.props, "submitLabel", "Send message");
  const successText = stringProp(node.props, "successText", "Thanks — your message has been sent.");
  const errorText = stringProp(node.props, "errorText", "Sorry, something went wrong. Please try again.");
  // A per-node id base, sanitised to what an HTML id / URL fragment may contain.
  const base = `zw-cf-${String(node.id).replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const sentId = `${base}-sent`;
  const errorId = `${base}-error`;
  return (
    <form
      className="zw-form"
      action="/api/contact/submit"
      method="post"
      data-note-ok={sentId}
      data-note-err={errorId}
    >
      {/* Which anchor the no-JS 303 returns to — makes the right banner reveal via
          :target even with several forms on the page. Ignored by the mail payload. */}
      <input type="hidden" name="_anchor" value={base} />
      <div className="zw-form-field">
        <label className="zw-form-label" htmlFor={`${base}-name`}>
          {nameLabel}
        </label>
        <input
          className="zw-form-input"
          id={`${base}-name`}
          name="name"
          type="text"
          required
          maxLength={200}
          autoComplete="name"
        />
      </div>
      <div className="zw-form-field">
        <label className="zw-form-label" htmlFor={`${base}-email`}>
          {emailLabel}
        </label>
        <input
          className="zw-form-input"
          id={`${base}-email`}
          name="email"
          type="email"
          required
          maxLength={320}
          autoComplete="email"
        />
      </div>
      <div className="zw-form-field">
        <label className="zw-form-label" htmlFor={`${base}-message`}>
          {messageLabel}
        </label>
        <textarea
          className="zw-form-input zw-form-textarea"
          id={`${base}-message`}
          name="message"
          required
          maxLength={5000}
          rows={5}
        />
      </div>
      {/* Hidden until revealed — by the enhancer (JS) or by :target (no-JS). */}
      <div className="zw-form-note zw-form-ok" id={sentId} role="status">
        {successText}
      </div>
      <div className="zw-form-note zw-form-err" id={errorId} role="alert">
        {errorText}
      </div>
      <button className="zw-button zw-button-primary zw-form-submit" type="submit">
        {submitLabel}
      </button>
    </form>
  );
};

export const Image: WidgetComponent = ({ node, ctx }) => {
  const src = stringProp(node.props, "src");
  if (!src) return null;
  const caption = stringProp(node.props, "caption");
  const width = stringProp(node.props, "width", "contained");
  return (
    <figure className={`zw-image zw-width-${width}`}>
      {/* ctx.asset resolves a theme-shipped path and passes an absolute one
          through, so a theme default and an owner's upload use the same call. */}
      <img src={ctx.asset(src)} alt={stringProp(node.props, "alt")} loading="lazy" />
      {caption ? <figcaption className="zw-caption">{caption}</figcaption> : null}
    </figure>
  );
};

export const Gallery: WidgetComponent = ({ node, ctx }) => {
  const images = stringArrayProp(node.props, "images");
  // No images is not an error — a gallery an author has not filled in yet draws
  // nothing, and the section around it collapses, exactly like an empty image.
  if (images.length === 0) return null;

  const layout = stringProp(node.props, "layout", "grid");
  const columns = Math.min(6, Math.max(1, numberProp(node.props, "columns", 3)));
  const gap = Math.min(64, Math.max(0, numberProp(node.props, "gap", 12)));

  return (
    <div
      className={`zw-gallery zw-gallery-${layout}`}
      style={{
        ["--zw-gallery-cols" as string]: String(columns),
        // `gap` covers grid and the carousel flex; masonry is a column layout, whose
        // vertical rhythm comes from the item margin that reads --zw-gallery-gap.
        ["--zw-gallery-gap" as string]: `${gap}px`,
        gap: `${gap}px`,
      }}
    >
      {images.map((src, i) => (
        // ctx.asset passes an absolute library URL through unchanged, the same call
        // the single image widget uses. Keys are index-based: the list is an ordered
        // prop, not a set of entities.
        <img key={i} className="zw-gallery-item" src={ctx.asset(src)} alt="" loading="lazy" />
      ))}
    </div>
  );
};

export const Logo: WidgetComponent = ({ node, ctx }) => {
  const height = numberProp(node.props, "height", 40);
  const settings = ctx.settings as Record<string, unknown>;
  const logo = typeof settings.logo === "string" ? settings.logo : "";
  const name = ctx.site?.name ?? "";
  return (
    <a className="zw-logo" href={ctx.url("/")}>
      {logo ? (
        <img src={ctx.asset(logo)} alt={name} style={{ height: `${height}px` }} />
      ) : (
        // A site with no logo still has a name, and a header with nothing in the
        // top-left corner reads as a broken page rather than a minimal one.
        <span className="zw-logo-text">{name}</span>
      )}
    </a>
  );
};

function MenuItems({ items, ctx }: { items: MenuItemDto[]; ctx: WidgetProps["ctx"] }) {
  return (
    <ul className="zw-menu-list">
      {items.map((item) => (
        <li key={item.id} className="zw-menu-item">
          <a href={item.url} target={item.target || undefined}>
            {item.label}
          </a>
          {item.children.length > 0 ? <MenuItems items={item.children} ctx={ctx} /> : null}
        </li>
      ))}
    </ul>
  );
}

export const Menu: WidgetComponent = ({ node, ctx }) => {
  const location = stringProp(node.props, "location", "primary");
  const menu = ctx.menus[location];
  // The location this theme names may simply not exist on the site it was
  // installed on. Nothing is the right answer; a stub menu would be a lie.
  if (!menu || menu.items.length === 0) return null;
  const orientation = stringProp(node.props, "orientation", "horizontal");
  return (
    <nav className={`zw-menu zw-menu-${orientation}`} aria-label={menu.name}>
      <MenuItems items={menu.items} ctx={ctx} />
    </nav>
  );
};

export const Spacer: WidgetComponent = ({ node }) => {
  const height = numberProp(node.props, "height", 48);
  return <div className="zw-spacer" style={{ height: `${height}px` }} aria-hidden="true" />;
};

export const PostTitle: WidgetComponent = ({ node, content }) => {
  // No content means no title. This happens on `home` and `archive`, where the
  // widget is simply in the wrong place — render nothing, not "Untitled".
  if (!content?.title) return null;
  const Tag = headingTag(node.props, 1) as "h1";
  return <Tag className={`zw-post-title ${alignClass(node.props)}`}>{content.title}</Tag>;
};

export const PostContent: WidgetComponent = ({ ctx, content }) => {
  if (!content?.blocks || content.blocks.length === 0) return null;
  // The one bridge between a drawn shell and hand-authored page content:
  // ctx.renderBlocks runs the block registry (core + theme + plugin blocks).
  return <div className="zw-post-content">{ctx.renderBlocks(content.blocks)}</div>;
};

function PostCard({
  row,
  ctx,
  showExcerpt,
}: {
  row: ContentDto;
  ctx: WidgetProps["ctx"];
  showExcerpt: boolean;
}) {
  return (
    <article className="zw-post-card">
      <a className="zw-post-card-link" href={ctx.url(row.path)}>
        {row.title}
      </a>
      {showExcerpt && row.excerpt ? <p className="zw-post-card-excerpt">{row.excerpt}</p> : null}
    </article>
  );
}

export const PostList: WidgetComponent = ({ node, ctx }) => {
  const binding = node.binding;
  if (!binding || binding.source !== "collection") return null;

  // The name is derived from the query, not stored: the code generator put the same
  // query in the manifest under the same derived name, so this lookup cannot drift
  // from what cms-api actually fetched. One pure function, two call sites.
  const name = collectionNameFor(bindingToCollectionQuery(binding));
  const rows = ctx.collections[name] ?? [];
  const heading = stringProp(node.props, "heading");
  const layout = stringProp(node.props, "layout", "list");
  const showExcerpt = boolProp(node.props, "showExcerpt", true);

  // An empty list is a NORMAL state — a brand-new site has no posts yet — and it is
  // worth saying so rather than leaving a hole a reader cannot distinguish from a
  // bug. The heading stays; the list says it is empty in the theme's own language.
  return (
    <div className={`zw-post-list zw-post-list-${layout}`}>
      {heading ? <h2 className="zw-post-list-heading">{heading}</h2> : null}
      {rows.length === 0 ? (
        <p className="zw-post-list-empty">{ctx.t("themeWidgets.postList.empty")}</p>
      ) : (
        <div className="zw-post-list-items">
          {rows.map((row) => (
            <PostCard key={row.id} row={row} ctx={ctx} showExcerpt={showExcerpt} />
          ))}
        </div>
      )}
    </div>
  );
};

/**
 * The slider shell shared by the image and content sliders.
 *
 * The whole thing is server-rendered and ships NO JavaScript: it is a scroll-snap
 * strip that swipes and keyboard-scrolls on its own, with arrow/dot ANCHORS that
 * scroll to a slide id even with scripting off. A single reviewed runtime script in
 * site-runtime (keyed off `data-zw-slider`) then enhances it — autoplay, active-dot
 * sync, pause-on-hover, reduced-motion — the same "runtime owns the JS, theme opts
 * in with a data attribute" contract as reveal-on-target and color-mode.
 *
 * `id` comes from the node id (unique in the document), so two sliders on a page
 * have non-colliding slide anchors.
 */
function SliderShell({
  id,
  slides,
  autoplay,
  interval,
  arrows,
  dots,
  style,
}: {
  id: string;
  slides: ReactNode[];
  autoplay: boolean;
  interval: number;
  arrows: boolean;
  dots: boolean;
  style?: CSSProperties;
}) {
  if (slides.length === 0) return null;
  const count = slides.length;
  const slideId = (i: number) => `${id}-s${i}`;

  return (
    <div
      className="zw-slider"
      data-zw-slider=""
      // The runtime script reads these; they are inert until it runs, and the slider
      // still works (swipe/scroll) without them.
      {...(autoplay ? { "data-autoplay": "" } : {})}
      data-interval={String(interval)}
      role="region"
      aria-roledescription="carousel"
      style={style}
    >
      <div className="zw-slider-track">
        {slides.map((slide, i) => (
          <div key={i} id={slideId(i)} className="zw-slide" aria-roledescription="slide">
            {slide}
          </div>
        ))}
      </div>

      {arrows && count > 1 ? (
        <>
          {/* Anchors, not buttons: prev/next scroll to a slide id with no JS. The
              runtime script intercepts them to move relative to the CURRENT slide. */}
          {/* No glyph text — the chevron is drawn in CSS (widgets.css) so it centres
              in the circle regardless of font metrics. */}
          <a
            className="zw-slider-arrow zw-slider-prev"
            href={`#${slideId(count - 1)}`}
            data-zw-slider-nav=""
            aria-label="Previous slide"
          />
          <a
            className="zw-slider-arrow zw-slider-next"
            href={`#${slideId(1 % count)}`}
            data-zw-slider-nav=""
            aria-label="Next slide"
          />
        </>
      ) : null}

      {dots && count > 1 ? (
        <div className="zw-slider-dots">
          {slides.map((_, i) => (
            <a
              key={i}
              className={`zw-slider-dot${i === 0 ? " is-active" : ""}`}
              href={`#${slideId(i)}`}
              data-zw-slider-nav=""
              aria-label={`Go to slide ${i + 1}`}
              {...(i === 0 ? { "aria-current": "true" } : {})}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The image URL for a content slide. `ContentDto` has no cover field — imagery lives
 * in the type's own `data` fields — so this looks at the conventional keys a theme
 * uses, then falls back to the SEO share image, then to nothing (the slide draws
 * text-only, never a broken image).
 */
function slideImage(row: ContentDto): string {
  const data = (row.data ?? {}) as Record<string, unknown>;
  for (const key of ["heroImage", "image", "cover", "coverImage", "thumbnail"]) {
    const value = data[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  const seo = row.seo as { ogImage?: unknown } | null | undefined;
  if (seo && typeof seo.ogImage === "string" && seo.ogImage.length > 0) return seo.ogImage;
  return "";
}

export const Slider: WidgetComponent = ({ node, ctx }) => {
  const images = stringArrayProp(node.props, "images");
  if (images.length === 0) return null;
  const height = Math.min(800, Math.max(120, numberProp(node.props, "height", 420)));

  return (
    <SliderShell
      id={node.id}
      autoplay={boolProp(node.props, "autoplay", true)}
      interval={numberProp(node.props, "interval", 5000)}
      arrows={boolProp(node.props, "arrows", true)}
      dots={boolProp(node.props, "dots", true)}
      style={{ ["--zw-slider-h" as string]: `${height}px` }}
      slides={images.map((src) => (
        <img className="zw-slide-image" src={ctx.asset(src)} alt="" loading="lazy" />
      ))}
    />
  );
};

export const ContentSlider: WidgetComponent = ({ node, ctx }) => {
  const binding = node.binding;
  if (!binding || binding.source !== "collection") return null;

  const name = collectionNameFor(bindingToCollectionQuery(binding));
  const rows = ctx.collections[name] ?? [];
  const heading = stringProp(node.props, "heading");
  const showExcerpt = boolProp(node.props, "showExcerpt", true);

  if (rows.length === 0) {
    // An empty collection is a normal state (a brand-new site) — say so, like PostList.
    return heading ? (
      <div className="zw-slider-wrap">
        <h2 className="zw-post-list-heading">{heading}</h2>
        <p className="zw-post-list-empty">{ctx.t("themeWidgets.postList.empty")}</p>
      </div>
    ) : null;
  }

  return (
    <div className="zw-slider-wrap">
      {heading ? <h2 className="zw-post-list-heading">{heading}</h2> : null}
      <SliderShell
        id={node.id}
        autoplay={boolProp(node.props, "autoplay", true)}
        interval={numberProp(node.props, "interval", 5000)}
        arrows={boolProp(node.props, "arrows", true)}
        dots={boolProp(node.props, "dots", true)}
        slides={rows.map((row) => {
          const image = slideImage(row);
          return (
            <a className="zw-content-slide" href={ctx.url(row.path)}>
              {image ? (
                <img className="zw-slide-image" src={ctx.asset(image)} alt="" loading="lazy" />
              ) : null}
              <div className="zw-content-slide-body">
                <span className="zw-content-slide-title">{row.title}</span>
                {showExcerpt && row.excerpt ? (
                  <p className="zw-content-slide-excerpt">{row.excerpt}</p>
                ) : null}
              </div>
            </a>
          );
        })}
      />
    </div>
  );
};

export const ArchiveList: WidgetComponent = ({ node, ctx }) => {
  // Only the archive template carries a paginated listing; everywhere else this is
  // null and the widget draws nothing (its post-list sibling covers ordinary lists).
  const archive = ctx.archive;
  if (!archive) return null;

  const layout = stringProp(node.props, "layout", "list");
  const showExcerpt = boolProp(node.props, "showExcerpt", true);

  if (archive.items.length === 0) {
    return <p className="zw-post-list-empty">{ctx.t("themeWidgets.postList.empty")}</p>;
  }

  return (
    <div className={`zw-post-list zw-post-list-${layout}`}>
      <div className="zw-post-list-items">
        {archive.items.map((row) => (
          <PostCard key={row.id} row={row} ctx={ctx} showExcerpt={showExcerpt} />
        ))}
      </div>
    </div>
  );
};

/** The page list — first/last always shown, current kept centred, capped at 7. */
type PageItem = number | "gap";
function paginationItems(page: number, totalPages: number): PageItem[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const start = Math.max(2, Math.min(page - 1, totalPages - 4));
  const end = Math.min(totalPages - 1, Math.max(page + 1, 5));
  const items: PageItem[] = [1];
  if (start > 2) items.push("gap");
  for (let value = start; value <= end; value += 1) items.push(value);
  if (end < totalPages - 1) items.push("gap");
  items.push(totalPages);
  return items;
}

export const Pagination: WidgetComponent = ({ node, ctx }) => {
  const archive = ctx.archive;
  if (!archive || archive.totalPages <= 1) return null;

  const { page, totalPages, basePath } = archive;
  const showNumbers = boolProp(node.props, "showNumbers", true);
  const shape = stringProp(node.props, "shape", "rounded");
  // Every link goes through ctx.url so it keeps the current locale ("/vi/blog?page=2"),
  // never resets to the default language. Page 1 is the bare path, no query.
  const href = (n: number) => (n <= 1 ? ctx.url(basePath) : ctx.url(`${basePath}?page=${n}`));

  // Colours ride in props, so they are validated HERE (colorProp) before becoming CSS
  // variables the stylesheet reads — an unset one falls back to the theme default.
  const navStyle: Record<string, string> = {};
  const pageBg = colorProp(node.props, "pageBackground");
  const pageColor = colorProp(node.props, "pageColor");
  const activeBg = colorProp(node.props, "activeBackground");
  const activeColor = colorProp(node.props, "activeColor");
  if (pageBg) navStyle["--zw-page-bg"] = pageBg;
  if (pageColor) navStyle["--zw-page-color"] = pageColor;
  if (activeBg) navStyle["--zw-page-active-bg"] = activeBg;
  if (activeColor) navStyle["--zw-page-active-color"] = activeColor;

  return (
    <nav className={`zw-pagination zw-pagination-${shape}`} style={navStyle} aria-label="Pagination">
      {page > 1 ? (
        <a className="zw-pagination-prev" href={href(page - 1)} rel="prev" aria-label="Previous page">
          ‹
        </a>
      ) : (
        <span className="zw-pagination-prev zw-pagination-disabled" aria-hidden="true">
          ‹
        </span>
      )}

      {showNumbers ? (
        <div className="zw-pagination-pages">
          {paginationItems(page, totalPages).map((item, i) =>
            item === "gap" ? (
              <span key={`gap-${i}`} className="zw-pagination-ellipsis" aria-hidden="true">
                …
              </span>
            ) : item === page ? (
              <span key={item} className="zw-pagination-page zw-pagination-active" aria-current="page">
                {item}
              </span>
            ) : (
              <a
                key={item}
                className="zw-pagination-page"
                href={href(item)}
                aria-label={`Go to page ${item}`}
              >
                {item}
              </a>
            ),
          )}
        </div>
      ) : (
        <span className="zw-pagination-status">
          {page} / {totalPages}
        </span>
      )}

      {page < totalPages ? (
        <a className="zw-pagination-next" href={href(page + 1)} rel="next" aria-label="Next page">
          ›
        </a>
      ) : (
        <span className="zw-pagination-next zw-pagination-disabled" aria-hidden="true">
          ›
        </span>
      )}
    </nav>
  );
};

// ---------------------------------------------------------------------------
// Common UI components.
//
// The same contract as everything above: a pure function of (props, ctx), no
// hooks, no state, no client JS. A component that has nothing to show renders
// null. `variant` becomes a class suffix the stylesheet keys off — an unknown
// value simply matches no rule and falls back to the base look, exactly as the
// button's variant already does.
// ---------------------------------------------------------------------------

export const Card: WidgetComponent = ({ node, ctx }) => {
  const image = stringProp(node.props, "image");
  const title = stringProp(node.props, "title");
  const text = stringProp(node.props, "text");
  const buttonLabel = stringProp(node.props, "buttonLabel");
  const href = stringProp(node.props, "href");
  // A card with nothing in it is nothing — an author who dropped it but has not
  // filled it in yet gets a collapsed slot, not an empty box.
  if (!image && !title && !text && !buttonLabel) return null;

  const body = (
    <>
      {image ? (
        <img className="zw-card-image" src={ctx.asset(image)} alt={title} loading="lazy" />
      ) : null}
      <div className="zw-card-body">
        {title ? <h3 className="zw-card-title">{title}</h3> : null}
        {text ? <p className="zw-card-text">{text}</p> : null}
        {href && buttonLabel ? (
          <span className="zw-button zw-button-primary zw-card-button">{buttonLabel}</span>
        ) : null}
      </div>
    </>
  );

  // A link with a label is a button inside the card; a link with none makes the
  // WHOLE card clickable. Both go through ctx.url so the locale is kept.
  return href && !buttonLabel ? (
    <a className="zw-card zw-card-link" href={ctx.url(href)}>
      {body}
    </a>
  ) : (
    <div className="zw-card">{body}</div>
  );
};

/** The first letter of each of the first two words — "Ada Lovelace" -> "AL". */
function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join("");
}

export const Avatar: WidgetComponent = ({ node, ctx }) => {
  const src = stringProp(node.props, "src");
  const name = stringProp(node.props, "name");
  const size = Math.min(200, Math.max(24, numberProp(node.props, "size", 56)));
  const shape = stringProp(node.props, "shape", "circle");
  const style = { width: `${size}px`, height: `${size}px` };
  const className = `zw-avatar zw-avatar-${shape}`;

  if (src) {
    return <img className={className} src={ctx.asset(src)} alt={name} style={style} loading="lazy" />;
  }
  // No image is a normal state — fall back to initials so a header still shows a
  // filled circle rather than a broken one. Font scales with the circle.
  const text = initials(name);
  if (!text) return null;
  return (
    <span
      className={`${className} zw-avatar-initials`}
      style={{ ...style, fontSize: `${Math.round(size * 0.4)}px` }}
      aria-label={name}
    >
      {text}
    </span>
  );
};

export const Badge: WidgetComponent = ({ node }) => {
  const label = stringProp(node.props, "label");
  if (!label) return null;
  const variant = stringProp(node.props, "variant", "primary");
  return <span className={`zw-badge zw-badge-${variant}`}>{label}</span>;
};

export const Tag: WidgetComponent = ({ node, ctx }) => {
  const label = stringProp(node.props, "label");
  if (!label) return null;
  const variant = stringProp(node.props, "variant", "neutral");
  const href = stringProp(node.props, "href");
  const className = `zw-tag zw-tag-${variant}`;
  return href ? (
    <a className={className} href={ctx.url(href)}>
      {label}
    </a>
  ) : (
    <span className={className}>{label}</span>
  );
};

export const Alert: WidgetComponent = ({ node }) => {
  const title = stringProp(node.props, "title");
  const text = stringProp(node.props, "text");
  if (!title && !text) return null;
  const variant = stringProp(node.props, "variant", "info");
  return (
    <div className={`zw-alert zw-alert-${variant}`} role="note">
      {title ? <div className="zw-alert-title">{title}</div> : null}
      {text ? <div className="zw-alert-text">{text}</div> : null}
    </div>
  );
};

export const Progress: WidgetComponent = ({ node }) => {
  const label = stringProp(node.props, "label");
  const value = Math.min(100, Math.max(0, numberProp(node.props, "value", 60)));
  const showValue = boolProp(node.props, "showValue", true);
  // The fill colour rides in a prop, so it is validated (colorProp) before it can
  // reach an inline style — an unset one falls back to the theme's primary.
  const barColor = colorProp(node.props, "barColor");
  const barStyle: Record<string, string> = { width: `${value}%` };
  if (barColor) barStyle.background = barColor;
  return (
    <div className="zw-progress-wrap">
      {label || showValue ? (
        <div className="zw-progress-head">
          {label ? <span className="zw-progress-label">{label}</span> : <span />}
          {showValue ? <span className="zw-progress-value">{value}%</span> : null}
        </div>
      ) : null}
      <div
        className="zw-progress"
        role="progressbar"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="zw-progress-bar" style={barStyle} />
      </div>
    </div>
  );
};

export const Rating: WidgetComponent = ({ node }) => {
  const max = Math.min(10, Math.max(1, Math.trunc(numberProp(node.props, "max", 5))));
  const value = Math.min(max, Math.max(0, numberProp(node.props, "value", 4)));
  const showValue = boolProp(node.props, "showValue", false);
  const stars = "★".repeat(max);
  const pct = (value / max) * 100;
  return (
    <div className="zw-rating" role="img" aria-label={`${value} / ${max}`}>
      {/* Two layers of the SAME star string: an outline track and a solid fill
          clipped to the score's width, so a fractional rating (3.5) draws without
          JS and without half-star glyphs. */}
      <span className="zw-rating-stars" aria-hidden="true">
        <span className="zw-rating-track">{stars}</span>
        <span className="zw-rating-fill" style={{ width: `${pct}%` }}>
          {stars}
        </span>
      </span>
      {showValue ? <span className="zw-rating-value">{value}</span> : null}
    </div>
  );
};

export const Accordion: WidgetComponent = ({ node }) => {
  // Four fixed slots; an item with no heading is skipped, so an author who fills
  // in two gets two, not two plus two empty rows.
  const items = [1, 2, 3, 4]
    .map((i) => ({
      q: stringProp(node.props, `q${i}`),
      a: stringProp(node.props, `a${i}`),
    }))
    .filter((item) => item.q.length > 0);
  if (items.length === 0) return null;
  const openFirst = boolProp(node.props, "openFirst", true);
  return (
    <div className="zw-accordion">
      {items.map((item, i) => (
        // Native <details>: opens and closes with no JavaScript at all.
        <details key={i} className="zw-accordion-item" {...(openFirst && i === 0 ? { open: true } : {})}>
          <summary className="zw-accordion-summary">{item.q}</summary>
          {item.a ? <div className="zw-accordion-body">{item.a}</div> : null}
        </details>
      ))}
    </div>
  );
};

export const Timeline: WidgetComponent = ({ node }) => {
  const html = stringProp(node.props, "html");
  if (!html) return null;
  // The list the author wrote is sanitised on save (the same path richtext takes);
  // the stylesheet turns each <li> into a timeline point (line + dot).
  return <div className="zw-timeline" dangerouslySetInnerHTML={{ __html: html }} />;
};

export const Table: WidgetComponent = ({ node }) => {
  const html = stringProp(node.props, "html");
  if (!html) return null;
  // Wrapped so a wide table scrolls inside its own box rather than pushing the page
  // sideways. The HTML is sanitised on save; table tags survive the allowlist.
  return <div className="zw-table" dangerouslySetInnerHTML={{ __html: html }} />;
};

/** "dog-food" -> "Dog food": a URL segment made into a readable crumb label. */
function deslugify(segment: string): string {
  const text = decodeURIComponent(segment).replace(/[-_]+/g, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : segment;
}

/** A menu URL reduced to the site-relative path breadcrumb matching needs. */
function menuPath(url: string): string | null {
  if (!url || url.startsWith("#") || /^[a-z][a-z\d+.-]*:/i.test(url)) return null;
  const path = url.split(/[?#]/, 1)[0] || "/";
  const withSlash = path.startsWith("/") ? path : `/${path}`;
  return withSlash === "/" ? "/" : withSlash.replace(/\/+$/, "");
}

/**
 * Find the deepest menu trail that points at the viewed page.
 *
 * A page URL can be intentionally flat (`/product-zpets`) while its information
 * architecture lives in the menu (`Products > Z-Pets`). Looking only at URL
 * segments loses that relationship, so the menu tree is the semantic source when
 * it contains a real parent. Searching every location also covers sites that put
 * their canonical hierarchy in a menu other than `primary`.
 */
function menuTrailForPath(
  menus: WidgetProps["ctx"]["menus"],
  path: string,
): MenuItemDto[] {
  const target = menuPath(path);
  if (!target) return [];
  let best: MenuItemDto[] = [];

  const visit = (items: MenuItemDto[], ancestors: MenuItemDto[]) => {
    for (const item of items) {
      const trail = [...ancestors, item];
      if (menuPath(item.url) === target && trail.length > best.length) best = trail;
      if (item.children.length > 0) visit(item.children, trail);
    }
  };

  for (const menu of Object.values(menus)) {
    if (menu) visit(menu.items, []);
  }
  return best;
}

export const Breadcrumb: WidgetComponent = ({ node, ctx, content }) => {
  // No viewed page means no trail — home and archive get nothing, like post-title.
  if (!content?.path) return null;
  const segments = content.path.split("/").filter(Boolean);
  if (segments.length === 0) return null;

  const showHome = boolProp(node.props, "showHome", true);
  const homeLabel = stringProp(node.props, "homeLabel", "Home");
  const separator = stringProp(node.props, "separator", "chevron");
  const sepChar = separator === "slash" ? "/" : separator === "dot" ? "·" : "›";

  type Crumb = { label: string; href?: string; current?: boolean };
  const crumbs: Crumb[] = [];
  if (showHome) crumbs.push({ label: homeLabel, href: "/" });

  const menuTrail = menuTrailForPath(ctx.menus, content.path);
  if (menuTrail.length > 1) {
    // The matching leaf is the current page; its real content title is more
    // authoritative than a possibly abbreviated menu label. Root/home ancestors
    // are omitted because the configurable Home crumb above already owns that role.
    for (const item of menuTrail.slice(0, -1)) {
      const href = menuPath(item.url);
      if (href === "/") continue;
      crumbs.push({ label: item.label, ...(href ? { href } : {}) });
    }
    crumbs.push({
      label: content.title || menuTrail.at(-1)?.label || deslugify(segments.at(-1)!),
      current: true,
    });
  } else {
    let acc = "";
    segments.forEach((segment, i) => {
      acc += `/${segment}`;
      const isLast = i === segments.length - 1;
      // The last segment IS the viewed page — use its real title, never the slug.
      // Earlier segments are ancestors we only know by their path, so they are
      // de-slugified and linked (every link through url() to keep the locale).
      if (isLast) crumbs.push({ label: content.title || deslugify(segment), current: true });
      else crumbs.push({ label: deslugify(segment), href: acc });
    });
  }

  return (
    <nav className="zw-breadcrumb" aria-label="Breadcrumb">
      <ol className="zw-breadcrumb-list">
        {crumbs.map((crumb, i) => (
          <li key={i} className="zw-breadcrumb-item">
            {crumb.href ? (
              <a href={ctx.url(crumb.href)}>{crumb.label}</a>
            ) : (
              <span aria-current={crumb.current ? "page" : undefined}>{crumb.label}</span>
            )}
            {i < crumbs.length - 1 ? (
              <span className="zw-breadcrumb-sep" aria-hidden="true">
                {sepChar}
              </span>
            ) : null}
          </li>
        ))}
      </ol>
    </nav>
  );
};

/**
 * The registry the renderer walks. A widget type absent from here renders nothing
 * — the same rule the block registry holds, and the reason a document drawn on a
 * newer editor still opens on an older runtime instead of crashing it.
 */
export const WIDGET_COMPONENTS: Record<string, WidgetComponent> = {
  "layout/heading": Heading,
  "layout/richtext": RichText,
  "layout/button": Button,
  "layout/menu": Menu,
  "layout/spacer": Spacer,
  "layout/contact-form": ContactForm,
  "media/image": Image,
  "media/gallery": Gallery,
  "media/slider": Slider,
  "media/logo": Logo,
  "dynamic/post-title": PostTitle,
  "dynamic/post-content": PostContent,
  "dynamic/post-list": PostList,
  "dynamic/content-slider": ContentSlider,
  "dynamic/archive-list": ArchiveList,
  "dynamic/pagination": Pagination,
  "content/card": Card,
  "media/avatar": Avatar,
  "content/badge": Badge,
  "content/tag": Tag,
  "content/alert": Alert,
  "content/progress": Progress,
  "content/rating": Rating,
  "content/accordion": Accordion,
  "content/timeline": Timeline,
  "content/table": Table,
  "dynamic/breadcrumb": Breadcrumb,
};
