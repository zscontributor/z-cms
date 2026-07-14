import type { Metadata } from "next";
import { can, getSession, listPlugins, type CatalogPluginDto } from "@/lib/api";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/table";
import { getT } from "@/lib/locale";
import { SideloadActions, SideloadUpload } from "@/components/sideload-controls";
import { PluginCard } from "./plugin-card";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("plugins.metaTitle") };
}

export const dynamic = "force-dynamic";

export default async function PluginsPage() {
  const t = await getT();
  const user = await getSession();

  if (!can(user, "plugin:read")) {
    return <div className="z-card p-10 text-center text-sm">{t("plugins.denied")}</div>;
  }

  const plugins = await safe<CatalogPluginDto[]>(listPlugins, []);

  const canInstall = can(user, "plugin:install");
  const canActivate = can(user, "plugin:activate");
  const canConfigure = can(user, "plugin:configure");
  const canSideload = can(user, "plugin:sideload");

  // Unverified = the operator's own sideloads. Everything else (built-in and
  // marketplace) is verified and shown in the normal installed/available groups.
  const sideloaded = plugins.filter((plugin) => plugin.origin === "SIDELOAD");
  const verified = plugins.filter((plugin) => plugin.origin !== "SIDELOAD");
  const installed = verified.filter((plugin) => plugin.installed);
  const available = verified.filter((plugin) => !plugin.installed);

  return (
    <>
      <PageHeader title={t("plugins.title")} description={t("plugins.description")} />

      {plugins.length === 0 ? (
        <div className="z-card">
          <EmptyState
            title={t("plugins.emptyTitle")}
            description={t("plugins.emptyDescription")}
          />
        </div>
      ) : null}

      {installed.length > 0 ? (
        <section className="mb-6">
          <h2 className="mb-2 text-sm font-semibold">{t("plugins.installedHeading")}</h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {installed.map((plugin) => (
              <PluginCard
                key={plugin.key}
                plugin={plugin}
                canInstall={canInstall}
                canActivate={canActivate}
                canConfigure={canConfigure}
              />
            ))}
          </div>
        </section>
      ) : null}

      {available.length > 0 ? (
        <section>
          <h2 className="mb-2 text-sm font-semibold">{t("plugins.catalogHeading")}</h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {available.map((plugin) => (
              <PluginCard
                key={plugin.key}
                plugin={plugin}
                canInstall={canInstall}
                canActivate={canActivate}
                canConfigure={canConfigure}
              />
            ))}
          </div>
        </section>
      ) : null}

      {canSideload || sideloaded.length > 0 ? (
        <section className="mt-6">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold">{t("appearance.sideload.heading")}</h2>
              <p className="mt-0.5 text-[11px] z-muted">{t("plugins.sideloadHint")}</p>
            </div>
            {canSideload ? <SideloadUpload kind="plugin" /> : null}
          </div>

          {sideloaded.length > 0 ? (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {sideloaded.map((plugin) => {
                const approved = plugin.reviewStatus === "APPROVED";
                return (
                  <article
                    key={plugin.key}
                    className="z-card border-amber-300/60 p-4 dark:border-amber-800/60"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h3 className="truncate text-sm font-semibold">{plugin.name}</h3>
                        <p className="mt-0.5 text-[11px] z-muted">
                          <code>{plugin.key}</code>
                          {plugin.latestVersion ? ` · v${plugin.latestVersion}` : null}
                        </p>
                      </div>
                      <Badge tone={approved ? "warning" : "danger"}>
                        {approved
                          ? t("appearance.sideload.unverified")
                          : t("appearance.sideload.pending")}
                      </Badge>
                    </div>
                    {plugin.description ? (
                      <p className="mt-2 line-clamp-3 text-xs z-muted">{plugin.description}</p>
                    ) : null}
                    {approved ? (
                      <p className="mt-2 text-[11px] z-muted">{t("plugins.sideloadApprovedHint")}</p>
                    ) : null}
                    {canSideload && plugin.latestVersion ? (
                      <SideloadActions
                        kind="plugin"
                        itemKey={plugin.key}
                        version={plugin.latestVersion}
                        reviewStatus={plugin.reviewStatus ?? "QUARANTINED"}
                      />
                    ) : null}
                  </article>
                );
              })}
            </div>
          ) : null}
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
