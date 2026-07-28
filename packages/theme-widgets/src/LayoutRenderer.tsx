import type { ReactNode } from "react";
import type { ContentDto, LayoutNode, LayoutTokens } from "@zcmsorg/schemas";
import type { ThemeContext } from "@zcmsorg/theme-sdk";
import {
  HOVER_ATTR,
  hasHover,
  numberProp,
  stringProp,
  styleForNode,
  tokensToStyle,
} from "./tokens";

/** `{ "data-zw-hover": "" }` when a node declares a hover effect, else nothing. */
function hoverAttr(node: LayoutNode): Record<string, string> {
  return hasHover(node.style) ? { [HOVER_ATTR]: "" } : {};
}
import { WIDGET_COMPONENTS } from "./widgets";

/**
 * The interpreter.
 *
 * A generated theme is a thin wrapper whose every template is one call to this
 * component with a different slice of the LayoutDocument. That is the load-bearing
 * fact of the whole GUI theme feature: what a stranger authored is the `nodes`
 * argument — data — and the code that turns it into HTML is this file, reviewed
 * once and shared by every drawn theme in existence.
 *
 * So the renderer is deliberately incurious. It does not eval, it does not accept a
 * component from the document, and it does not look up anything by a name the
 * document chose except in a closed registry (WIDGET_COMPONENTS). A node it does not
 * recognise is skipped. There is no path from a LayoutDocument to executing code.
 */

function Column({
  node,
  children,
}: {
  node: LayoutNode;
  children: ReactNode;
}) {
  const span = Math.min(12, Math.max(1, numberProp(node.props, "span", 12)));
  return (
    // The 12-column grid as a flex basis. The stylesheet stacks columns below the
    // breakpoint by overriding this, so `span` is a desktop instruction and narrow
    // screens are never asked to honour a 2-of-12 column. A node's own style is
    // spread LAST so it wins over the structural default it overlaps.
    <div
      className="zw-column"
      style={{ ["--zw-span" as string]: String(span), ...styleForNode(node.style) }}
      {...hoverAttr(node)}
    >
      {children}
    </div>
  );
}

function Row({ node, children }: { node: LayoutNode; children: ReactNode }) {
  const gap = numberProp(node.props, "gap", 24);
  const align = stringProp(node.props, "align", "stretch");
  return (
    <div
      className={`zw-row zw-row-${align}`}
      // --zw-row-gap lets each column subtract its share of the gaps from its basis
      // so a full 12-span row fits on one line instead of wrapping (see widgets.css).
      style={{ gap: `${gap}px`, ["--zw-row-gap" as string]: `${gap}px`, ...styleForNode(node.style) }}
      {...hoverAttr(node)}
    >
      {children}
    </div>
  );
}

function Section({ node, children }: { node: LayoutNode; children: ReactNode }) {
  const background = stringProp(node.props, "background");
  const paddingY = numberProp(node.props, "paddingY", 64);
  const width = stringProp(node.props, "width", "contained");
  return (
    <section
      className="zw-section"
      style={{
        // An unset background is omitted, not "": an empty declaration is invalid
        // and would drop the whole style attribute in some engines.
        ...(background ? { background } : {}),
        paddingTop: `${paddingY}px`,
        paddingBottom: `${paddingY}px`,
        // The node's own style wins over the legacy prop defaults it overlaps
        // (background, paddingY), which is what lets the Style drawer supersede the
        // older section props without a migration.
        ...styleForNode(node.style),
      }}
      {...hoverAttr(node)}
    >
      <div className={`zw-section-inner zw-width-${width}`}>{children}</div>
    </section>
  );
}

interface NodeProps {
  node: LayoutNode;
  ctx: ThemeContext;
  content?: ContentDto | null;
}

function LayoutNodeView({ node, ctx, content }: NodeProps) {
  if (node.kind === "widget") {
    const Widget = node.widgetType ? WIDGET_COMPONENTS[node.widgetType] : undefined;
    // Unknown widget: skip. A document drawn on a newer editor must not be able to
    // break an older runtime — it renders the parts that exist and omits the rest.
    if (!Widget) return null;
    const rendered = <Widget node={node} ctx={ctx} content={content} />;
    // A widget draws its own markup, so per-node style rides on a wrapper — but only
    // when there is style to apply, so a styleless widget keeps the exact DOM it had
    // before (no stray div to change a column's flex layout).
    const nodeStyle = styleForNode(node.style);
    if (Object.keys(nodeStyle).length === 0) return rendered;
    return (
      <div className="zw-widget" style={nodeStyle} {...hoverAttr(node)}>
        {rendered}
      </div>
    );
  }

  const children = (node.children ?? []).map((child) => (
    <LayoutNodeView key={child.id} node={child} ctx={ctx} content={content} />
  ));

  if (node.kind === "section") return <Section node={node}>{children}</Section>;
  if (node.kind === "row") return <Row node={node}>{children}</Row>;
  if (node.kind === "column") return <Column node={node}>{children}</Column>;
  return null;
}

export interface LayoutRendererProps {
  /** One template's tree, already selected from the document. */
  nodes: LayoutNode[];
  ctx: ThemeContext;
  /** The viewed page, on `page`/`post`. Absent on `home`/`archive`. */
  content?: ContentDto | null;
  /**
   * The document's design tokens. Emitted as CSS variables on the root so the whole
   * subtree — and `widgets.css` — reads one set of values.
   */
  tokens?: LayoutTokens;
}

export function LayoutRenderer({ nodes, ctx, content, tokens }: LayoutRendererProps) {
  return (
    <div className="zw-root" style={tokensToStyle(tokens)}>
      {nodes.map((node) => (
        <LayoutNodeView key={node.id} node={node} ctx={ctx} content={content} />
      ))}
    </div>
  );
}
