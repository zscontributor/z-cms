import type { CSSProperties, ReactNode } from "react";
import type { ContentDto, MenuItemDto } from "@zcmsorg/schemas";
import { bindingToCollectionQuery, collectionNameFor } from "@zcmsorg/schemas";
import type { WidgetComponent, WidgetProps } from "./types";
import { boolProp, numberProp, stringArrayProp, stringProp } from "./tokens";

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
  const href = stringProp(node.props, "href");
  if (!label || !href) return null;
  const variant = stringProp(node.props, "variant", "primary");
  return (
    <div className={`zw-button-wrap ${alignClass(node.props)}`}>
      <a className={`zw-button zw-button-${variant}`} href={ctx.url(href)}>
        {label}
      </a>
    </div>
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
  // Every link goes through ctx.url so it keeps the current locale ("/vi/blog?page=2"),
  // never resets to the default language. Page 1 is the bare path, no query.
  const href = (n: number) => (n <= 1 ? ctx.url(basePath) : ctx.url(`${basePath}?page=${n}`));

  return (
    <nav className="zw-pagination" aria-label="Pagination">
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
};
