import type { ContentDto, MenuItemDto } from "@zcmsorg/schemas";
import { bindingToCollectionQuery, collectionNameFor } from "@zcmsorg/schemas";
import type { WidgetComponent, WidgetProps } from "./types";
import { boolProp, numberProp, stringProp } from "./tokens";

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
  "media/logo": Logo,
  "dynamic/post-title": PostTitle,
  "dynamic/post-content": PostContent,
  "dynamic/post-list": PostList,
};
