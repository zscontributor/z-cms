"use client";

import { useEffect, useRef } from "react";
import type { ContentDto, LayoutNode, LayoutTokens } from "@zcmsorg/schemas";
import { LayoutRenderer } from "@zcmsorg/theme-widgets";
import type { ThemeContext } from "@zcmsorg/theme-sdk";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n-provider";
import type { StudioDevice } from "./devices";
import { DEVICE_WIDTH } from "./devices";
import { enhanceSliders } from "./enhance-sliders";

/**
 * A chrome-less full render of the drawn template — "see the theme, not the editor".
 *
 * It draws the SAME @zcmsorg/theme-widgets LayoutRenderer the built theme uses, so
 * the preview is the real output, not a second rendering. No selection outlines, no
 * toolbars, no pointer-events tricks: this is what a visitor would see. Data is
 * still the editor's preview context (sample rows) until M3 wires real content.
 */
export function PreviewOverlay({
  nodes,
  tokens,
  ctx,
  device,
  content = null,
  onClose,
}: {
  nodes: LayoutNode[];
  tokens: LayoutTokens;
  ctx: ThemeContext;
  device: StudioDevice;
  /** The stand-in page for current-bound widgets (title/content) — null off page/post. */
  content?: ContentDto | null;
  onClose: () => void;
}) {
  const t = useT();
  const stageRef = useRef<HTMLDivElement>(null);

  // Escape closes it — a full-screen overlay with no keyboard exit is a trap.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Bring sliders to life the way the live site does — the runtime slider script is
  // not here, so wire arrows/dots/autoplay over the rendered preview directly.
  useEffect(() => {
    if (!stageRef.current) return;
    return enhanceSliders(stageRef.current);
  }, [nodes, device]);

  const width = DEVICE_WIDTH[device];

  // The preview is a single-template snapshot, not a browsable site: every widget
  // link (an archive item, a pager, a menu entry) points at a real theme URL that
  // does not exist under the admin origin, so a click would leave the editor and
  // 404. Swallow anchor clicks and form submits so the preview stays put — real
  // navigation is a live-site concern, not the editor's.
  const swallowNavigation = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement | null)?.closest?.("a")) e.preventDefault();
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-neutral-900/95 backdrop-blur">
      <div className="flex items-center justify-between border-b border-neutral-700 px-4 py-2 text-neutral-200">
        <span className="text-sm font-medium">{t("themeEditor.studio.previewTitle")}</span>
        <Button size="sm" variant="ghost" onClick={onClose}>
          {t("themeEditor.studio.closePreview")}
        </Button>
      </div>
      <div
        ref={stageRef}
        className={cn("min-h-0 flex-1 overflow-auto", width ? "p-6" : "")}
        onClick={swallowNavigation}
        onSubmit={(e) => e.preventDefault()}
      >
        <div
          className={cn(
            "mx-auto bg-white",
            width ? "shadow-2xl transition-[width]" : "min-h-full",
          )}
          style={{ width: width ?? "100%", maxWidth: "100%" }}
        >
          <LayoutRenderer nodes={nodes} ctx={ctx} tokens={tokens} content={content} />
        </div>
      </div>
    </div>
  );
}
