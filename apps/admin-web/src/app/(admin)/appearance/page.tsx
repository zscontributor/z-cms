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
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/ui/table";
import { MediaGallery } from "@/components/ui/media-gallery";
import { getT } from "@/lib/locale";
import { SideloadUpload } from "@/components/sideload-controls";
import { ActivateButton } from "./activate-button";
import { ThemeGrid } from "./theme-grid";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("appearance.metaTitle") };
}

export const dynamic = "force-dynamic";

export default async function AppearancePage() {
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
            <ThemeGrid
              themes={sideloaded}
              activeKey={activeKey}
              canActivate={canActivate}
              canConfigure={canConfigure}
              canSideload={canSideload}
              sideloaded
            />
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
        <ThemeGrid
          themes={verified}
          activeKey={activeKey}
          canActivate={canActivate}
          canConfigure={canConfigure}
        />
      )}

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
