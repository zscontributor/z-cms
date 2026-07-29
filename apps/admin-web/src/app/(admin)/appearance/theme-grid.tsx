"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button, LinkButton } from "@/components/ui/button";
import { ChangelogNote } from "@/components/changelog-note";
import { Dialog } from "@/components/ui/dialog";
import { Icon } from "@/components/shell/icon";
import { MediaGallery } from "@/components/ui/media-gallery";
import { SideloadActions } from "@/components/sideload-controls";
import { UpdateBadge, UpdateButton, hasUpdate } from "@/components/package-update";
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
  canEdit = false,
  draftIdByKey,
  latestVersionByKey,
  canInstall = false,
  sideloaded = false,
}: {
  themes: InstalledThemeDto[];
  activeKey: string | null;
  canActivate: boolean;
  canConfigure: boolean;
  canSideload?: boolean;
  /** `theme:author` — may open the editor. Gates the Edit button. */
  canEdit?: boolean;
  /** Theme key → the id of the draft it was drawn from, when one still exists. */
  draftIdByKey?: Record<string, string>;
  /** Theme key → newest version the marketplace offers, for the "update available" flag. */
  latestVersionByKey?: Record<string, string>;
  /** `theme:install` — may pull a newer version from the marketplace. Gates Update. */
  canInstall?: boolean;
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
          canEdit={canEdit}
          draftId={draftIdByKey?.[theme.key]}
          latestVersion={latestVersionByKey?.[theme.key] ?? null}
          canInstall={canInstall}
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
  canEdit,
  draftId,
  latestVersion,
  canInstall,
  sideloaded,
}: {
  theme: InstalledThemeDto;
  activeKey: string | null;
  canActivate: boolean;
  canConfigure: boolean;
  canSideload: boolean;
  canEdit: boolean;
  draftId?: string;
  latestVersion: string | null;
  canInstall: boolean;
  sideloaded: boolean;
}) {
  const t = useT();
  const [settingsOpen, setSettingsOpen] = useState(false);
  // A marketplace theme with a newer version out there. Sideloads are the
  // operator's own files, not marketplace packages, so they never show this.
  const updatable = !sideloaded && hasUpdate(theme.version, latestVersion);
  // Portal target for the settings form's Save / Restore bar, so it lands in the
  // Dialog's sticky footer (like the plugin permissions dialog) instead of at the
  // foot of the scrolling body.
  const [footerActions, setFooterActions] = useState<HTMLDivElement | null>(null);

  const isActive = theme.key === activeKey;
  const approved = theme.reviewStatus === "APPROVED";

  return (
    <article
      className={cn(
        "z-card group relative p-4",
        sideloaded && "border-amber-300/60 dark:border-amber-800/60",
        isActive && "border-brand-500 ring-1 ring-brand-500/30",
      )}
    >
      {/* An installed theme only has an editable canvas when it came from a
          surviving draft. Keep the shortcut on the preview itself so editing
          feels like an action on the theme, not a secondary list action. */}
      {canEdit && draftId ? (
        <LinkButton
          href={`/theme-editor/${draftId}`}
          size="sm"
          variant="secondary"
          className="absolute left-2 top-2 z-10 h-8 w-8 px-0 opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          aria-label={t("appearance.edit")}
          title={t("appearance.edit")}
        >
          <Icon name="edit" className="h-4 w-4" />
        </LinkButton>
      ) : null}

      {canConfigure ? (
        <Button
          size="sm"
          variant="ghost"
          className="absolute right-2 top-2 z-10 h-9 w-9 px-0 bg-background/70 backdrop-blur-sm hover:bg-background/90"
          onClick={() => setSettingsOpen(true)}
          aria-label={t("appearance.settings.heading", { name: theme.name })}
        >
          <Icon name="settings" className="h-6 w-6" />
        </Button>
      ) : null}

      <MediaGallery screenshots={theme.screenshots} name={theme.name} className="mb-3" />

      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 pr-8">
          <h2 className="truncate text-sm font-semibold">{theme.name}</h2>
          <p className="mt-0.5 text-[11px] z-muted">
            <code>{theme.key}</code> · v{theme.version}
          </p>
          {updatable ? (
            <div className="mt-1.5">
              <UpdateBadge latestVersion={latestVersion!} />
            </div>
          ) : null}
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

      <ChangelogNote
        label={t("appearance.changelog", { version: theme.version })}
        changelog={theme.changelog}
      />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {isActive ? (
          <p className="text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
            {t("appearance.active")}
          </p>
        ) : (!sideloaded || approved) && canActivate ? (
          <ActivateButton themeKey={theme.key} name={theme.name} />
        ) : null}

        {updatable && canInstall ? (
          <UpdateButton kind="theme" itemKey={theme.key} latestVersion={latestVersion!} />
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
          <div className="flex flex-1 items-center gap-3">
            <div ref={setFooterActions} className="flex flex-1 items-center gap-3" />
            {isActive && theme.demoAvailable && canConfigure ? (
              <SeedDemoButton seeded={theme.demoSeeded} />
            ) : null}
          </div>
        }
      >
        <ThemeSettingsForm
          themeKey={theme.key}
          schema={theme.settingsSchema}
          settings={theme.settings ?? {}}
          disabled={!canConfigure}
          actionsSlot={footerActions}
        />
      </Dialog>
    </article>
  );
}
