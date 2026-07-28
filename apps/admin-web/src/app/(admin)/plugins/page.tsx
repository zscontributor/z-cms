import type { Metadata } from "next";
import { can, getSession, listPlugins, type CatalogPluginDto } from "@/lib/api";
import { PageHeader } from "@/components/page-header";
import { getT } from "@/lib/locale";
import { PluginBrowser } from "./plugin-browser";

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

      <PluginBrowser
        sideloaded={sideloaded}
        installed={installed}
        available={available}
        isEmpty={plugins.length === 0}
        canInstall={canInstall}
        canActivate={canActivate}
        canConfigure={canConfigure}
        canSideload={canSideload}
      />
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
