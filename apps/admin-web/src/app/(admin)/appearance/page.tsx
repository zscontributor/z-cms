import type { Metadata } from "next";
import {
  can,
  getCurrentSite,
  getSession,
  listInstalledThemes,
  listThemeCatalog,
  type InstalledThemeDto,
  type ThemeCatalogEntry,
} from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { Icon } from "@/components/shell/icon";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/ui/table";
import { MediaGallery } from "@/components/ui/media-gallery";
import { getT } from "@/lib/locale";
import { cn } from "@/lib/cn";
import { SideloadActions, SideloadUpload } from "@/components/sideload-controls";
import { ActivateButton } from "./activate-button";
import { SeedDemoButton } from "./seed-demo-button";
import { ThemeSettingsForm } from "./theme-settings-form";

interface PageProps {
  searchParams: Promise<{ theme?: string }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("appearance.metaTitle") };
}

export const dynamic = "force-dynamic";

export default async function AppearancePage({ searchParams }: PageProps) {
  const { theme: selectedKey } = await searchParams;
  const t = await getT();
  const user = await getSession();

  if (!can(user, "theme:read")) {
    return <div className="z-card p-10 text-center text-sm">{t("appearance.denied")}</div>;
  }

  const [site, installed, catalog] = await Promise.all([
    getCurrentSite(),
    safe<InstalledThemeDto[]>(listInstalledThemes, []),
    safe<ThemeCatalogEntry[]>(listThemeCatalog, []),
  ]);

  const activeKey = site?.activeTheme?.key ?? null;
  const active = installed.find((theme) => theme.key === activeKey) ?? null;
  const selectedTheme = selectedKey
    ? installed.find((theme) => theme.key === selectedKey) ?? null
    : null;
  const installedKeys = new Set(installed.map((theme) => theme.key));
  const available = catalog.filter((entry) => !installedKeys.has(entry.key));

  // Verified (built-in + marketplace) versus unverified (the operator's own
  // sideloads). Kept apart on screen so "installed" never blurs "reviewed".
  const verified = installed.filter((theme) => theme.origin !== "SIDELOAD");
  const sideloaded = installed.filter((theme) => theme.origin === "SIDELOAD");

  const canActivate = can(user, "theme:activate");
  const canConfigure = can(user, "theme:configure");
  const canSideload = can(user, "theme:sideload");

  return (
    <>
      <PageHeader title={t("appearance.title")} description={t("appearance.description")} />

      {canSideload || sideloaded.length > 0 ? (
        <section className="mb-5">
          <div className="mb-2">
            <div>
              <h2 className="text-sm font-semibold">{t("appearance.sideload.heading")}</h2>
              <p className="mt-0.5 text-[11px] z-muted">{t("appearance.sideload.hint")}</p>
            </div>
            {canSideload ? (
              <div className="mt-2 flex justify-start">
                <SideloadUpload kind="theme" />
              </div>
            ) : null}
          </div>

          {sideloaded.length > 0 ? (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {sideloaded.map((theme) => {
                const isActive = theme.key === activeKey;
                const isSelected = theme.key === selectedTheme?.key;
                const approved = theme.reviewStatus === "APPROVED";
                return (
                  <article
                    key={theme.key}
                    className={cn(
                      "z-card border-amber-300/60 p-4 dark:border-amber-800/60",
                      isSelected && "ring-2 ring-brand-500/40",
                    )}
                  >
                    <MediaGallery
                      screenshots={theme.screenshots}
                      name={theme.name}
                      className="mb-3"
                    />
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h3 className="truncate text-sm font-semibold">{theme.name}</h3>
                        <p className="mt-0.5 text-[11px] z-muted">
                          <code>{theme.key}</code> · v{theme.version}
                        </p>
                      </div>
                      <Badge tone={approved ? "warning" : "danger"}>
                        {approved
                          ? t("appearance.sideload.unverified")
                          : t("appearance.sideload.pending")}
                      </Badge>
                    </div>

                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <LinkButton
                        href={`/appearance?theme=${encodeURIComponent(theme.key)}`}
                        variant="ghost"
                        size="sm"
                        className={cn(isSelected && "bg-[var(--surface-sunken)] text-[var(--text)]")}
                        aria-label={t("appearance.settings.heading", { name: theme.name })}
                      >
                        <Icon name="settings" className="h-3.5 w-3.5" />
                      </LinkButton>

                      {isActive ? (
                        <p className="text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                          {t("appearance.active")}
                        </p>
                      ) : approved && canActivate ? (
                        <ActivateButton themeKey={theme.key} name={theme.name} />
                      ) : null}
                    </div>

                    {canSideload ? (
                      <SideloadActions
                        kind="theme"
                        itemKey={theme.key}
                        version={theme.version}
                        reviewStatus={theme.reviewStatus}
                      />
                    ) : null}
                  </article>
                );
              })}
            </div>
          ) : null}
        </section>
      ) : null}

      {installed.length === 0 ? (
        <div className="z-card">
          <EmptyState
            title={t("appearance.emptyTitle")}
            description={t("appearance.emptyDescription")}
          />
        </div>
      ) : (
        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {verified.map((theme) => {
            const isActive = theme.key === activeKey;
            const isSelected = theme.key === selectedTheme?.key;
            return (
              <article
                key={theme.key}
                className={cn(
                  "z-card p-4",
                  isActive && "border-brand-500 ring-1 ring-brand-500/30",
                  isSelected && "ring-2 ring-brand-500/40",
                )}
              >
                <MediaGallery
                  screenshots={theme.screenshots}
                  name={theme.name}
                  className="mb-3"
                />
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="truncate text-sm font-semibold">{theme.name}</h2>
                    <p className="mt-0.5 text-[11px] z-muted">
                      <code>{theme.key}</code> · v{theme.version}
                    </p>
                  </div>
                  {isActive ? (
                    <Badge tone="success">{t("appearance.active")}</Badge>
                  ) : (
                    <Badge tone="neutral">{theme.status}</Badge>
                  )}
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <LinkButton
                    href={`/appearance?theme=${encodeURIComponent(theme.key)}`}
                    variant="ghost"
                    size="sm"
                    className={cn(isSelected && "bg-[var(--surface-sunken)] text-[var(--text)]")}
                    aria-label={t("appearance.settings.heading", { name: theme.name })}
                  >
                    <Icon name="settings" className="h-3.5 w-3.5" />
                  </LinkButton>

                  {!isActive && canActivate ? (
                    <ActivateButton themeKey={theme.key} name={theme.name} />
                  ) : null}
                </div>
              </article>
            );
          })}
        </section>
      )}

      {selectedTheme ? (
        <section className="z-card mt-5 p-4">
          <header className="mb-4 flex items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold">
                {t("appearance.settings.heading", { name: selectedTheme.name })}
              </h2>
              <p className="mt-0.5 text-[11px] z-muted">
                {selectedTheme.key === active?.key && selectedTheme.demoAvailable
                  ? selectedTheme.demoSeeded
                    ? t("appearance.demo.seededHint")
                    : t("appearance.demo.availableHint")
                  : t("appearance.settings.generated")}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {selectedTheme.key === active?.key && selectedTheme.demoAvailable && canConfigure ? (
                <SeedDemoButton seeded={selectedTheme.demoSeeded} />
              ) : null}
              <LinkButton
                href="/appearance"
                variant="ghost"
                size="sm"
                aria-label={t("common.close")}
              >
                <Icon name="close" className="h-4 w-4" />
              </LinkButton>
            </div>
          </header>

          <ThemeSettingsForm
            themeKey={selectedTheme.key}
            schema={selectedTheme.settingsSchema}
            settings={selectedTheme.settings ?? {}}
            disabled={!canConfigure}
          />
        </section>
      ) : null}

      {available.length > 0 ? (
        <section className="mt-5">
          <h2 className="mb-2 text-sm font-semibold">{t("appearance.available")}</h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {available.map((entry) => (
              <article key={entry.key} className="z-card p-4">
                <MediaGallery
                  screenshots={entry.screenshots}
                  name={entry.name}
                  className="mb-3"
                />
                <h3 className="text-sm font-semibold">{entry.name}</h3>
                <p className="mt-0.5 text-[11px] z-muted">
                  {entry.author} · v{entry.versions[entry.versions.length - 1]?.version ?? "—"}
                </p>
                <p className="mt-2 line-clamp-3 text-xs z-muted">{entry.description}</p>
                {canActivate ? (
                  <div className="mt-3">
                    <ActivateButton themeKey={entry.key} name={entry.name} />
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}
