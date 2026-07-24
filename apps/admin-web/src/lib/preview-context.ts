import type { ContentDto, MenuDto } from "@zcmsorg/schemas";
import type { ThemeContext } from "@zcmsorg/theme-sdk";

/**
 * A ThemeContext for the editor's canvas.
 *
 * The canvas draws the REAL widgets from @zcmsorg/theme-widgets — the same
 * components the generated theme will use — so what an author sees while dragging
 * is what the theme renders. That only works if they can be handed a ThemeContext,
 * which on a live site is built by site-runtime from a RenderPayload. Here it is
 * built from what the admin already has: the site, its menus, its content types.
 *
 * The parts that cannot be faithful are honest about it rather than empty:
 *
 *   - `collections` are SAMPLE rows, not the site's. The canvas is a design
 *     surface, and fetching eight live queries on every keystroke would be a
 *     database load in exchange for showing an author their own posts, which they
 *     have already seen. Real rows arrive when the theme actually renders.
 *   - `renderBlocks` draws a placeholder. The block registry is the runtime's, and
 *     a page's blocks are not knowable while drawing a template that has no page.
 *   - `hasCapability` is false: plugins are not loaded here, and a canvas that
 *     claimed a capability would draw UI the real site may not have.
 *
 * None of this is a mock in the testing sense. It is the honest answer to "what
 * does this widget look like", given that the thing being drawn is a template and
 * a template has no single page.
 */

export interface PreviewContextInput {
  siteName: string;
  locale: string;
  menus: MenuDto[];
  /** Theme tokens are applied by LayoutRenderer, not through settings. */
  settings?: Record<string, unknown>;
}

/** A handful of plausible rows so a post-list is not an empty box while drawing. */
export function sampleRows(count: number, label: string): ContentDto[] {
  return Array.from({ length: Math.min(count, 6) }, (_, i) => ({
    id: `sample-${i}`,
    title: `${label} ${i + 1}`,
    path: "#",
    excerpt: "…",
  })) as unknown as ContentDto[];
}

export function buildPreviewContext(input: PreviewContextInput): ThemeContext {
  const menus: Record<string, MenuDto | undefined> = {};
  for (const menu of input.menus) menus[menu.key] = menu;

  const ctx = {
    site: { name: input.siteName },
    settings: input.settings ?? {},
    menus,
    locale: input.locale,
    // The catalogue key itself, so an untranslated widget string is visible as a
    // key rather than silently blank on the canvas.
    t: (key: string) => key,
    renderBlocks: () => null,
    hasCapability: () => false,
    getIntegration: () => undefined,
    renderSlot: () => null,
    // No locale prefix and no host: a canvas link is not for following.
    url: (path: string) => path,
    asset: (path: string) => path,
    alternates: [],
    colorMode: {
      modes: ["light", "dark"],
      default: "system",
      toggleable: true,
      attribute: "data-theme",
    },
    // Filled per-render by the canvas from the document's own bindings.
    collections: {},
  };

  return ctx as unknown as ThemeContext;
}
