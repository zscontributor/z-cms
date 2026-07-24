import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createThemeTranslator,
  resolveAssetUrl,
  resolveColorModes,
  resolveThemeSettings,
} from "@zcmsorg/theme-sdk";

/**
 * Builds the ThemeContext and renders the tree to an HTML string.
 *
 * This is site-runtime's `lib/theme-context.tsx` moved across the thread boundary,
 * and the move is cheaper than it looks because the seam was already there:
 * `buildThemeContext(theme, payload, assetBase)` takes exactly three things, and
 * two of them — `payload` and `assetBase` — are plain data. Only `theme` was ever
 * unshippable, and the worker imports that itself. Nothing needed to be split.
 *
 * ctx is still half closures (`t`, `url`, `asset`, `renderBlocks`, `renderSlot`,
 * `hasCapability`, `getIntegration`) and still self-referential. None of that
 * matters now: the closures are created HERE, on the same side of the boundary as
 * the React that will call them. Only the finished HTML crosses back.
 *
 * Two things had to change, and both are contract changes rather than mechanics —
 * see the notes on `renderBlocks` and `renderSlot` below.
 */
export function renderThemeToHtml(
  theme: ThemeLike,
  template: string,
  rawPayload: unknown,
  content: unknown,
  assetBase: string,
): string {
  // The payload crossed a postMessage boundary, so it is `unknown` by construction
  // and this is the only place that decides otherwise. It is not attacker-authored
  // — cms-api produced it and site-runtime forwarded it — so the cast asserts a
  // trusted shape rather than skipping a check on hostile input.
  const payload = rawPayload as PayloadLike;
  const settings = resolveThemeSettings(
    theme.manifest.settingsSchema as never,
    payload.theme?.settings as never,
  );

  const t = createThemeTranslator(theme.messages as never, payload.site.locale);

  const integrations: Record<string, unknown> = { ...(payload.integrations ?? {}) };
  if (!integrations["ai.assistant"] && payload.aiAssistant) {
    integrations["ai.assistant"] = {
      capability: "ai.assistant",
      provider: { pluginKey: "vn.zsoft.plugin.zai", version: "legacy" },
      data: payload.aiAssistant,
    };
  }

  const ctx: Record<string, unknown> = {
    site: payload.site,
    settings,
    menus: payload.menus,
    locale: payload.site.locale,
    t,
    renderBlocks: (blocks: BlockLike[]) => renderBlocks(blocks, theme, ctx),
    hasCapability: (capability: string) => (payload.capabilities ?? []).includes(capability),
    getIntegration: (capability: string) => integrations[capability],

    // ALWAYS null, and this is the contract change.
    //
    // `renderSlot` returned a ReactNode, and for "floating" that node was
    // <AiAssistant> — a "use client" component with useState. A client component is
    // a *reference* the RSC payload points at, not markup; renderToStaticMarkup here
    // would either inline it as dead HTML or throw. So the slot moves out: all four
    // shipped themes call renderSlot("floating") and nothing else, "floating" is
    // position:fixed by definition, and a fixed-position element does not care where
    // in the DOM it sits. site-runtime renders it as a sibling of this HTML.
    //
    // The other four slots in the type (header-after, page-before, page-after,
    // footer-before) ARE positional and cannot be stitched from outside. No theme
    // uses one today. They return null here rather than silently rendering in the
    // wrong place — a slot that appears somewhere unintended is worse than a slot
    // that visibly does not appear.
    renderSlot: () => null,

    url: (path: string) => buildUrl(payload.site, path),
    asset: (path: string) => resolveAssetUrl(assetBase, path),
    alternates: payload.alternates,
    collections: payload.collections ?? {},
    colorMode: resolveColorModes(theme.manifest as never, settings as Record<string, unknown>),
  };

  const Template = (theme.templates[template] ?? theme.templates.page) as React.ComponentType<{
    ctx: unknown;
    content: unknown;
  }>;
  const Layout = theme.Layout as React.ComponentType<{ ctx: unknown; children?: React.ReactNode }>;

  return renderToStaticMarkup(
    React.createElement(Layout, { ctx }, React.createElement(Template, { ctx, content })),
  );
}

/**
 * Renders each block, isolating a throw to the block that threw.
 *
 * site-runtime wrapped every block in <BlockBoundary>, a "use client" React error
 * boundary. That cannot come along: error boundaries need a client component, and
 * `renderToStaticMarkup` does not run them anyway.
 *
 * So each block is rendered to its own HTML string inside a try/catch, and the
 * strings are stitched with dangerouslySetInnerHTML. The isolation is not weaker
 * for it — it is strictly stronger, and the reason is worth stating plainly:
 * BlockBoundary never caught the failure that actually mattered. An error boundary
 * catches a THROW. It cannot catch `while(true){}`, because a component that never
 * returns never gives React anything to catch. That block hung the request thread
 * and every tenant with it. Here, the same block hangs this worker, the parent's
 * deadline fires, and the page falls back — the loop is contained by the thread,
 * and the throw by this try/catch. Between them there is no longer a gap.
 *
 * Unknown types are skipped exactly as before: block types are an open set, and a
 * page whose theme was swapped for one that does not know a type must still serve.
 */
function renderBlocks(blocks: BlockLike[], theme: ThemeLike, ctx: unknown): React.ReactNode {
  if (!Array.isArray(blocks) || blocks.length === 0) return null;

  const parts: React.ReactNode[] = [];

  for (const block of blocks) {
    if (!block || typeof block.type !== "string") continue;

    const Component = theme.blocks?.[block.type] as
      | React.ComponentType<{ block: unknown; props: unknown; ctx: unknown }>
      | undefined;
    if (!Component) continue;

    try {
      const html = renderToStaticMarkup(
        React.createElement(Component, { block, props: block.props ?? {}, ctx }),
      );
      parts.push(
        React.createElement("div", {
          key: block.id,
          "data-zcms-block": block.type,
          dangerouslySetInnerHTML: { __html: html },
        }),
      );
    } catch (err) {
      // The page survives minus this block, and the operator gets told which one.
      // Silently dropping it is how a theme bug becomes a content bug nobody can
      // reproduce.
      console.error(
        `[theme-runner] block "${block.type}" (${block.id}) failed to render:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return React.createElement(React.Fragment, null, ...parts);
}

/**
 * Site-root-relative URL builder handed to themes as `ctx.url`.
 *
 * The same rule as site-runtime's `buildUrl`, which this replaces rather than
 * duplicates: once the render lives here, ctx is built here, and site-runtime's
 * copy goes away with the rest of `lib/theme-context.tsx`.
 *
 * A multi-locale site serves its non-default locales under a prefix ("/en/blog"),
 * and a theme must never have to know that. Query strings and fragments survive,
 * and an absolute URL (an external menu item) passes through untouched.
 */
export function buildUrl(site: SiteLike, path: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//")) return path;

  const index = path.search(/[?#]/);
  const [pathname, suffix] = index === -1 ? [path, ""] : [path.slice(0, index), path.slice(index)];
  const clean = pathname.startsWith("/") ? pathname : `/${pathname}`;

  // Read from `defaultLocale`, not `locales[0]`: the array is the site's display
  // order, and an admin reordering it must not silently move every URL on the site.
  const prefix = site.locale && site.locale !== site.defaultLocale ? `/${site.locale}` : "";

  const joined = `${prefix}${clean}`.replace(/\/{2,}/g, "/");
  const normalised = joined.length > 1 ? joined.replace(/\/$/, "") : joined;

  return `${normalised}${suffix}`;
}

interface SiteLike {
  locale: string;
  defaultLocale?: string;
  [k: string]: unknown;
}

interface BlockLike {
  id: string;
  type: string;
  props?: unknown;
}

interface ThemeLike {
  Layout: unknown;
  templates: Record<string, unknown>;
  blocks?: Record<string, unknown>;
  manifest: Record<string, unknown>;
  messages?: unknown;
}

interface PayloadLike {
  site: SiteLike;
  theme?: { settings?: unknown };
  menus?: unknown;
  capabilities?: string[];
  integrations?: Record<string, unknown>;
  aiAssistant?: unknown;
  alternates?: unknown;
  collections?: unknown;
}
