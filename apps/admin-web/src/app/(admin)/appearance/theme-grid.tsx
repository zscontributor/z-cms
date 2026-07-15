"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Icon } from "@/components/shell/icon";
import { MediaGallery } from "@/components/ui/media-gallery";
import { SideloadActions } from "@/components/sideload-controls";
import type { InstalledThemeDto } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n-provider";
import { ActivateButton } from "./activate-button";
import { SeedDemoButton } from "./seed-demo-button";
import { ThemeSettingsForm } from "./theme-settings-form";

export function ThemeGrid({
  themes,
  activeKey,
  canActivate,
  canConfigure,
  canSideload,
  sideloaded = false,
}: {
  themes: InstalledThemeDto[];
  activeKey: string | null;
  canActivate: boolean;
  canConfigure: boolean;
  canSideload?: boolean;
  sideloaded?: boolean;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {themes.map((theme) => (
        <ThemeCard
          key={theme.key}
          theme={theme}
          activeKey={activeKey}
          canActivate={canActivate}
          canConfigure={canConfigure}
          canSideload={canSideload ?? false}
          sideloaded={sideloaded}
        />
      ))}
    </div>
  );
}

function ThemeCard({
  theme,
  activeKey,
  canActivate,
  canConfigure,
  canSideload,
  sideloaded,
}: {
  theme: InstalledThemeDto;
  activeKey: string | null;
  canActivate: boolean;
  canConfigure: boolean;
  canSideload: boolean;
  sideloaded: boolean;
}) {
  const t = useT();
  const [settingsOpen, setSettingsOpen] = useState(false);

  const isActive = theme.key === activeKey;
  const approved = theme.reviewStatus === "APPROVED";

  return (
    <article
      className={cn(
        "z-card relative p-4",
        sideloaded && "border-amber-300/60 dark:border-amber-800/60",
        isActive && "border-brand-500 ring-1 ring-brand-500/30",
      )}
    >
      {canConfigure ? (
        <Button
          size="sm"
          variant="ghost"
          className="absolute right-2 top-2 z-10 h-8 w-8 px-0"
          onClick={() => setSettingsOpen(true)}
          aria-label={t("appearance.settings.heading", { name: theme.name })}
        >
          <Icon name="settings" className="h-4 w-4" />
        </Button>
      ) : null}

      <MediaGallery screenshots={theme.screenshots} name={theme.name} className="mb-3" />

      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 pr-8">
          <h2 className="truncate text-sm font-semibold">{theme.name}</h2>
          <p className="mt-0.5 text-[11px] z-muted">
            <code>{theme.key}</code> · v{theme.version}
          </p>
        </div>
        {sideloaded ? (
          <Badge tone={approved ? "warning" : "danger"} className="mr-8">
            {approved
              ? t("appearance.sideload.unverified")
              : t("appearance.sideload.pending")}
          </Badge>
        ) : isActive ? (
          <Badge tone="success" className="mr-8">
            {t("appearance.active")}
          </Badge>
        ) : (
          <Badge tone="neutral" className="mr-8">
            {theme.status}
          </Badge>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {isActive ? (
          <p className="text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
            {t("appearance.active")}
          </p>
        ) : (!sideloaded || approved) && canActivate ? (
          <ActivateButton themeKey={theme.key} name={theme.name} />
        ) : null}
      </div>

      {sideloaded && canSideload ? (
        <SideloadActions
          kind="theme"
          itemKey={theme.key}
          version={theme.version}
          reviewStatus={theme.reviewStatus}
        />
      ) : null}

      <Dialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title={t("appearance.settings.heading", { name: theme.name })}
        description={
          isActive && theme.demoAvailable
            ? theme.demoSeeded
              ? t("appearance.demo.seededHint")
              : t("appearance.demo.availableHint")
            : t("appearance.settings.generated")
        }
        className="z-[90] w-[min(44rem,calc(100vw-2rem))]"
        footer={
          isActive && theme.demoAvailable && canConfigure ? (
            <SeedDemoButton seeded={theme.demoSeeded} />
          ) : null
        }
      >
        <ThemeSettingsForm
          themeKey={theme.key}
          schema={theme.settingsSchema}
          settings={theme.settings ?? {}}
          disabled={!canConfigure}
        />
      </Dialog>
    </article>
  );
}
