import type { ContentDto, LayoutNode } from "@zcmsorg/schemas";
import type { ThemeContext } from "@zcmsorg/theme-sdk";

/**
 * What every widget receives.
 *
 * Note what is NOT here: no database handle, no fetch, no site id. A widget draws
 * what the runtime already resolved into `ctx` — the same `ThemeContext` a
 * hand-written theme gets, and the same hard limit on what a theme can reach.
 * A drawn theme is not more privileged than a coded one; it is less, because it
 * cannot even write the code that would ask.
 */
export interface WidgetProps {
  node: LayoutNode;
  ctx: ThemeContext;
  /**
   * The page being viewed, when there is one. `page` and `post` templates have it;
   * `home` and `archive` do not, and a widget bound to a "current" field renders
   * nothing there rather than inventing a placeholder.
   */
  content?: ContentDto | null;
}

/** A widget component: props in, server-rendered markup out. No hooks, no state. */
export type WidgetComponent = (props: WidgetProps) => React.ReactNode;
