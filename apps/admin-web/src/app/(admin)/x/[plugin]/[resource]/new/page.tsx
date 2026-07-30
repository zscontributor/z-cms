import { notFound } from "next/navigation";
import { ApiError, getPluginResourceForm } from "@/lib/api";
import { PageHeader } from "@/components/page-header";
import { getT } from "@/lib/locale";
import { RETURN_PARAM, returnHref } from "@/lib/return-to";
import { CreatePanel } from "./create-panel";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ plugin: string; resource: string }>;
  /** `?from=…` — the list state this form was opened from. See lib/return-to. */
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * The create screen of a plugin's resource.
 *
 * It was a form that appeared above the table on the list screen, and that is the
 * one arrangement of these three screens with no way out: the record screen has a
 * back link, the list has the sidebar, and a create form pushed the table it
 * covered off the bottom of the window while the only cancel sat below every
 * field. It also had no URL — a plugin could not link "add a shift" from anywhere,
 * and a reload lost what you were doing without saying so.
 *
 * So creating gets its own address, the same way editing already had one: a screen
 * with the resource's name on it, "back to list" where every other record screen
 * keeps it, and a cancel beside save. The list it came from — page, filters,
 * ordering — rides along in `?from=` and is where both of those return to.
 *
 * `new` cannot collide with a record: every plugin row id is a uuid.
 */
export default async function PluginRecordCreatePage({ params, searchParams }: PageProps) {
  const { plugin, resource } = await params;
  const search = await searchParams;
  const t = await getT();

  let data: Awaited<ReturnType<typeof getPluginResourceForm>>;
  try {
    data = await getPluginResourceForm(plugin, resource);
  } catch (error) {
    // 403 as well as 404: a reader who may not write this resource has no create
    // screen, and saying so would only describe a door they cannot open.
    if (error instanceof ApiError && (error.status === 404 || error.status === 403)) notFound();
    throw error;
  }

  const descriptor = data.resource;
  // A resource that declares no form has nothing to fill in — the list renders
  // read-only for everyone, and this URL is a dead end rather than a blank card.
  if (!descriptor.form) notFound();

  const listPath = `/x/${encodeURIComponent(plugin)}/${encodeURIComponent(resource)}`;
  const backPath = returnHref(listPath, search[RETURN_PARAM]);

  return (
    <>
      <PageHeader
        title={t("plugins.resource.newTitle")}
        description={descriptor.label}
        back={{ href: backPath, label: t("plugins.resource.back") }}
      />

      <CreatePanel
        pluginKey={plugin}
        resourceKey={resource}
        basePath={listPath}
        backPath={backPath}
        returnTo={typeof search[RETURN_PARAM] === "string" ? search[RETURN_PARAM] : undefined}
        fields={descriptor.form.fields}
        columnTypes={descriptor.columnTypes}
        columnBounds={descriptor.columnBounds}
        labels={{ save: t("common.save"), cancel: t("common.cancel") }}
      />
    </>
  );
}
