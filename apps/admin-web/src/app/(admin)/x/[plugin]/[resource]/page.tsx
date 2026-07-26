import { notFound } from "next/navigation";
import { getSession, listPluginResource } from "@/lib/api";
import { PageHeader } from "@/components/page-header";
import { getT } from "@/lib/locale";
import { ResourcePanel } from "./resource-panel";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ plugin: string; resource: string }>;
  searchParams: Promise<{ page?: string }>;
}

/**
 * The generic plugin resource screen. It knows nothing about any particular
 * plugin — it fetches the descriptor and rows the plugin-admin endpoint returns
 * (which are already gated by the caller's permissions there) and renders the
 * list/form the descriptor describes. A plugin gets a first-class admin screen
 * without shipping a line of admin code.
 */
export default async function PluginResourcePage({ params, searchParams }: PageProps) {
  const { plugin, resource } = await params;
  const { page } = await searchParams;
  const t = await getT();
  const user = await getSession();

  let data: Awaited<ReturnType<typeof listPluginResource>>;
  try {
    data = await listPluginResource(plugin, resource, {
      page: Math.max(1, Number(page) || 1),
    });
  } catch {
    // A 403/404 from the endpoint (not installed, not permitted, no such resource)
    // is a missing screen from the user's point of view.
    notFound();
  }

  const descriptor = data.resource;
  // Writable only if the resource declares a write permission AND the user holds
  // it. The endpoint enforces this too; here it just decides what to render.
  const canWrite = Boolean(
    descriptor.permissions.write && user?.permissions.includes(descriptor.permissions.write),
  );

  return (
    <>
      <PageHeader title={descriptor.label} />
      <ResourcePanel
        pluginKey={plugin}
        resourceKey={resource}
        descriptor={descriptor}
        rows={data.rows}
        canWrite={canWrite}
        labels={{
          new: t("common.new"),
          edit: t("common.edit"),
          delete: t("common.delete"),
          save: t("common.save"),
          cancel: t("common.cancel"),
          empty: t("common.empty"),
          confirmDelete: t("common.confirmDelete"),
          actions: t("common.actions"),
        }}
      />
    </>
  );
}
