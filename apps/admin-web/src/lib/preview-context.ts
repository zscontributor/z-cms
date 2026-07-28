import { createElement } from "react";
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
  /** Placeholder paragraphs (already localised by the caller) that stand in for a
   *  page's block content in the Preview's page-content widget. */
  sampleBody?: string[];
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

/**
 * A sample "page being viewed" for the Preview, so the current-bound widgets (page
 * title, page content) have something to draw. A template has no real page while it
 * is being designed, so these show nothing on the canvas — the Preview stands in a
 * plausible article to demonstrate the layout. Only the `post`/`page` templates get
 * this; `home`/`archive` are not a single page and keep `content` null.
 */
export function sampleContent(strings: { title: string; excerpt: string }): ContentDto {
  return {
    id: "sample-page",
    title: strings.title,
    excerpt: strings.excerpt,
    path: "#",
    // One block is enough for post-content to render; renderBlocks below turns it
    // into placeholder paragraphs.
    blocks: [{ id: "sb1", type: "core/richtext", props: {} }],
    data: {},
    seo: {},
  } as unknown as ContentDto;
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
    // The real block registry is the runtime's and is not available while designing,
    // so a page's blocks are drawn as the caller's localised placeholder paragraphs —
    // enough for the page-content widget to show a filled body in the Preview.
    renderBlocks: (blocks: unknown) =>
      Array.isArray(blocks) && blocks.length > 0 && (input.sampleBody?.length ?? 0) > 0
        ? createElement(
            "div",
            { className: "zw-richtext" },
            ...(input.sampleBody ?? []).map((para, i) =>
              createElement("p", { key: `p${i}` }, para),
            ),
          )
        : null,
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
    // A sample archive so the Archive-list and Pagination widgets have something to
    // draw while designing — on a live site this is null off the archive template.
    archive: {
      contentTypeKey: "post",
      basePath: "/blog",
      items: sampleRows(6, "Post"),
      page: 1,
      totalPages: 3,
    },
  };

  return ctx as unknown as ThemeContext;
}
