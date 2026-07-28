"use client";

import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/shell/icon";
import type { CatalogPluginDto } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n-provider";

/**
 * One plugin as a single row in the catalogue list. The whole row is the button
 * that opens the detail drawer — the list stays scannable when there are dozens
 * of plugins, and every action a card used to carry now lives in the drawer.
 */
export function PluginRow({
  plugin,
  badge,
  selected,
  onOpen,
}: {
  plugin: CatalogPluginDto;
  /** The status/review badge shown on the right — meaning differs per shelf. */
  badge: ReactNode;
  selected: boolean;
  onOpen: () => void;
}) {
  const t = useT();

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      className={cn(
        "flex w-full items-center gap-3 px-4 py-3 text-left transition-colors",
        "hover:bg-[var(--surface-sunken)] focus-visible:bg-[var(--surface-sunken)] focus-visible:outline-none",
        selected ? "bg-[var(--surface-sunken)]" : null,
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-semibold">{plugin.name}</span>
          {plugin.tier === "PLATFORM" ? (
            <Badge tone="info">{t("plugins.card.tier.platform")}</Badge>
          ) : plugin.tier === "ORG" ? (
            <Badge tone="neutral">{t("plugins.card.tier.org")}</Badge>
          ) : null}
        </div>
        <p className="mt-0.5 truncate text-[11px] z-muted">
          <code>{plugin.key}</code>
          {plugin.latestVersion ? ` · v${plugin.latestVersion}` : null} · {plugin.publisher}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {badge}
        <Icon name="chevron-right" className="h-4 w-4 z-muted" />
      </div>
    </button>
  );
}
