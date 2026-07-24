import type { ReactNode } from "react";
import type { Block, RenderIntegration, RenderPayload } from "@zcmsorg/schemas";
import {
  createThemeTranslator,
  resolveAssetUrl,
  resolveColorModes,
  resolveThemeSettings,
  type Theme,
  type ThemeContext,
} from "@zcmsorg/theme-sdk";
import { BlockBoundary } from "@/components/block-boundary";
import { renderIntegrationSlot } from "@/lib/integration-registry";

/**
 * Turns a RenderPayload into the ThemeContext a template sees.
 *
 * This is the whole of a theme's access to the platform: whatever is not on this
 * object, a theme cannot reach — no database, no cms-api, no Next.js internals.
 * Keeping the construction here (and not in the page) means every render path —
 * page, archive, 404 — hands the theme an identically-shaped world.
 *
 * `assetBase` comes from the loader, because only the loader knows how this theme
 * arrived: unpacked from a signed bundle under a key and a version, or compiled in
 * as the built-in fallback. The theme is told neither; it just names its files.
 */
export function buildThemeContext<S = Record<string, unknown>>(
  theme: Theme<S>,
  payload: RenderPayload,
  assetBase: string,
): ThemeContext<S> {
  const settings = resolveThemeSettings<S>(
    theme.manifest.settingsSchema,
    payload.theme.settings,
  );

  // The theme's own catalogue, never core's. A theme translated into Japanese
  // works on a platform that has no Japanese, and vice versa — the two are not
  // the same catalogue and are not released together.
  const t = createThemeTranslator(theme.messages, payload.site.locale);

  // Accept one generation of cached payloads from before `integrations` existed.
  // The compatibility adapter is intentionally specific and contains public data
  // only; new plugin integrations must come from cms-api's projector registry.
  const integrations: Record<string, RenderIntegration> = { ...(payload.integrations ?? {}) };
  if (!integrations["ai.assistant"] && payload.aiAssistant) {
    integrations["ai.assistant"] = {
      capability: "ai.assistant",
      provider: { pluginKey: "vn.zsoft.plugin.zai", version: "legacy" },
      data: payload.aiAssistant,
    };
  }

  // Self-referential: block components receive the very context they are being
  // rendered into, so a block can call ctx.renderBlocks on its own children.
  const ctx: ThemeContext<S> = {
    site: payload.site,
    settings,
    menus: payload.menus,
    locale: payload.site.locale,
    t,
    renderBlocks: (blocks: Block[]) => renderBlocks(blocks, theme, ctx),
    hasCapability: (capability: string) => payload.capabilities.includes(capability),
    getIntegration: <T = unknown>(capability: string) =>
      integrations[capability] as RenderIntegration<T> | undefined,
    renderSlot: (slot) => renderIntegrationSlot(slot, integrations),
    url: (path: string) => buildUrl(payload.site, path),
    asset: (path: string) => resolveAssetUrl(assetBase, path),
    alternates: payload.alternates,

    // The lists the theme declared in its manifest, already run by cms-api. Defaulted
    // to {} rather than passed straight through: a payload from a cache written before
    // collections existed has no such field, and a theme is documented as being able
    // to map over `ctx.collections.latest` without a guard. It should get an empty
    // list, not a crash, on the one render that spans a deploy.
    collections: payload.collections ?? {},

    // Resolved by the SAME function the document shell used to build the bootstrap
    // script (lib/color-mode-server.ts). Deriving it twice from one rule is what
    // stops a theme from drawing a toggle the runtime has decided to ignore — a
    // switch that is visible but inert is worse than no switch at all.
    colorMode: resolveColorModes(
      theme.manifest,
      settings as Record<string, unknown>,
    ),
  };

  return ctx;
}

/**
 * Renders a block document with the active theme's block map.
 *
 * Unknown types are *skipped*, never thrown on: block types are an open set
 * (plugins register their own), so a page whose theme was swapped for one that
 * does not know "commerce/product-grid" must still serve — minus that block.
 * In development the hole is made visible instead, because silently dropping
 * content is exactly the bug an author would not report.
 */
export function renderBlocks<S>(
  blocks: Block[],
  theme: Theme<S>,
  ctx: ThemeContext<S>,
): ReactNode {
  if (!Array.isArray(blocks) || blocks.length === 0) return null;

  return (
    <>
      {blocks.map((block) => {
        if (!block || typeof block.type !== "string") return null;

        const Component = theme.blocks[block.type];

        if (!Component) {
          if (process.env.NODE_ENV !== "production") {
            console.warn(
              `[blocks] Theme "${theme.manifest.id}" has no component for "${block.type}" (block ${block.id}).`,
            );
            return <UnknownBlock key={block.id} type={block.type} />;
          }
          return null;
        }

        return (
          <BlockBoundary key={block.id} blockType={block.type}>
            <Component
              block={block}
              props={block.props ?? {}}
              // BlockComponent<P> is only generic over its *props*: BlockProps
              // pins the context to ThemeContext<Record<string, unknown>>, so a
              // block cannot be typed against its theme's settings the way a
              // template can. The object handed over is the very same one the
              // templates get — this cast is the type system catching up with a
              // gap in the SDK, not a lie about the value.
              ctx={ctx as ThemeContext<Record<string, unknown>>}
            />
          </BlockBoundary>
        );
      })}
    </>
  );
}

function UnknownBlock({ type }: { type: string }) {
  return (
    <div
      role="alert"
      className="mx-auto my-4 max-w-3xl rounded-lg border-2 border-dashed border-amber-400 bg-amber-50 p-4 text-sm text-amber-900"
    >
      <p className="font-semibold">
        Unknown block type “{type}”.
      </p>
      <p className="mt-1 text-xs text-amber-800">
        The active theme registers no component for it, so it is skipped. This
        warning is development-only; in production the block renders nothing.
      </p>
    </div>
  );
}

/**
 * Site-root-relative URL builder handed to themes as `ctx.url`.
 *
 * A multi-locale site serves its non-default locales under a prefix ("/en/blog"),
 * and a theme must never have to know that. Query strings and fragments survive,
 * and an absolute URL (an external menu item) passes through untouched.
 */
export function buildUrl(site: RenderPayload["site"], path: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//")) return path;

  const [pathname = "", suffix = ""] = splitSuffix(path);
  const clean = pathname.startsWith("/") ? pathname : `/${pathname}`;

  // The default locale is served unprefixed; every other locale carries its code.
  // Read from `defaultLocale` rather than `locales[0]`: the array is the site's
  // display order, and an admin reordering it must not silently move every URL on
  // the site.
  const prefix =
    site.locale && site.locale !== site.defaultLocale ? `/${site.locale}` : "";

  const joined = `${prefix}${clean}`.replace(/\/{2,}/g, "/");
  const normalised = joined.length > 1 ? joined.replace(/\/$/, "") : joined;

  return `${normalised}${suffix}`;
}

/** Splits "/blog?page=2#x" into ["/blog", "?page=2#x"]. */
function splitSuffix(path: string): [string, string] {
  const index = path.search(/[?#]/);
  return index === -1
    ? [path, ""]
    : [path.slice(0, index), path.slice(index)];
}
