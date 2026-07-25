import type { Metadata } from "next";
import { can, getSession, listOrgPlugins, type CatalogPluginDto } from "@/lib/api";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/ui/table";
import { getT } from "@/lib/locale";
import { PluginCard } from "../plugins/plugin-card";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("plugins.org.metaTitle") };
}

export const dynamic = "force-dynamic";

export default async function OrgPluginsPage() {
  const t = await getT();
  const user = await getSession();

  if (!can(user, "plugin:read")) {
    return <div className="z-card p-10 text-center text-sm">{t("plugins.denied")}</div>;
  }

  const plugins = await safe<CatalogPluginDto[]>(listOrgPlugins, []);

  const canInstall = can(user, "plugin:install");
  const canActivate = can(user, "plugin:activate");
  const canConfigure = can(user, "plugin:configure");

  const installed = plugins.filter((plugin) => plugin.installed);
  const available = plugins.filter((plugin) => !plugin.installed);

  return (
    <>
      <PageHeader title={t("plugins.org.title")} description={t("plugins.org.description")} />

      {plugins.length === 0 ? (
        <div className="z-card">
          <EmptyState
            title={t("plugins.org.emptyTitle")}
            description={t("plugins.org.emptyDescription")}
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
                tier="org"
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
                tier="org"
                canInstall={canInstall}
                canActivate={canActivate}
                canConfigure={canConfigure}
              />
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
