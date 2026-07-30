import { notFound } from "next/navigation";
import { getSession, listPluginResource, type PluginSortDirection } from "@/lib/api";
import { PageHeader } from "@/components/page-header";
import { Pagination } from "@/components/pagination";
import { getT } from "@/lib/locale";
import { filterableColumns } from "./filterable";
import { ListToolbar } from "./list-toolbar";
import { ResourcePanel } from "./resource-panel";

export const dynamic = "force-dynamic";

/** `f.status=new` in, `{ status: "new" }` out. Everything else is left alone. */
function filtersFromSearch(search: Record<string, string | string[] | undefined>) {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(search)) {
    if (!key.startsWith("f.") || typeof value !== "string" || value === "") continue;
    out[key.slice(2)] = value;
  }
  return out;
}

interface PageProps {
  params: Promise<{ plugin: string; resource: string }>;
  /** Open-ended: `f.<column>` filters arrive here alongside the fixed parameters. */
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * The generic plugin resource screen. It knows nothing about any particular
 * plugin — it fetches the descriptor and rows the plugin-admin endpoint returns
 * (which are already gated by the caller's permissions there) and renders the
 * list/form the descriptor describes. A plugin gets a first-class admin screen
 * without shipping a line of admin code.
 *
 * Page, page size, ordering, search and filters all live in the URL and are all
 * resolved by the endpoint — the screen sends what the reader asked for and renders
 * what the server says it did. That is why a `sort` or a filter value the plugin
 * never declared degrades to the unfiltered, plugin-ordered list rather than an
 * error page: a stale bookmark should show records.
 */
export default async function PluginResourcePage({ params, searchParams }: PageProps) {
  const { plugin, resource } = await params;
  const search = await searchParams;
  const t = await getT();
  const user = await getSession();

  const asString = (value: string | string[] | undefined): string | undefined =>
    typeof value === "string" && value !== "" ? value : undefined;

  const page = asString(search.page);
  const perPage = asString(search.perPage);
  const sort = asString(search.sort);
  const dir = asString(search.dir);
  const q = asString(search.q);
  const filters = filtersFromSearch(search);

  let data: Awaited<ReturnType<typeof listPluginResource>>;
  try {
    data = await listPluginResource(plugin, resource, {
      page: Math.max(1, Number(page) || 1),
      ...(perPage ? { perPage: Number(perPage) } : {}),
      ...(sort ? { sort } : {}),
      ...(dir === "desc" || dir === "asc" ? { dir: dir as PluginSortDirection } : {}),
      ...(q ? { q } : {}),
      ...(Object.keys(filters).length ? { filters } : {}),
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

  const basePath = `/x/${encodeURIComponent(plugin)}/${encodeURIComponent(resource)}`;

  return (
    <>
      <PageHeader title={descriptor.label} />

      <ListToolbar
        perPage={data.perPage}
        searchable={data.searchable.length > 0}
        filters={data.filters}
        columns={filterableColumns(descriptor)}
        labels={{
          search: t("plugins.resource.search"),
          searchPlaceholder: t("plugins.resource.searchPlaceholder"),
          perPage: t("plugins.resource.perPage"),
          all: t("plugins.resource.filterAll"),
          yes: t("common.on"),
          no: t("common.off"),
        }}
      />

      <ResourcePanel
        pluginKey={plugin}
        resourceKey={resource}
        descriptor={descriptor}
        rows={data.rows}
        canWrite={canWrite}
        order={data.order}
        labels={{
          new: t("common.new"),
          view: t("plugins.resource.view"),
          delete: t("common.delete"),
          empty: t("common.empty"),
          confirmDelete: t("common.confirmDelete"),
          actions: t("common.actions"),
          sortAsc: t("plugins.resource.sortAsc"),
          sortDesc: t("plugins.resource.sortDesc"),
        }}
      />

      {/* Server-rendered, so every page of a plugin's records is a real URL that can
          be linked, bookmarked and reloaded — the same pager the content and order
          lists use, rather than a second one that behaves almost the same. Every
          control's state rides along, or paging would silently reset it. */}
      <Pagination
        page={data.page}
        totalPages={Math.max(1, Math.ceil(data.total / data.perPage))}
        total={data.total}
        basePath={basePath}
        query={{
          perPage,
          q,
          // Only what the reader actually chose, and only if the server honoured
          // it: writing the plugin's default ordering into every link would pin a
          // default that is the plugin's to change.
          ...(sort && data.order?.column === sort
            ? { sort, dir: data.order.direction === "desc" ? "desc" : undefined }
            : {}),
          // The filters the server ACCEPTED, so a page link cannot carry one it
          // dropped and make the next page disagree with this one.
          ...Object.fromEntries(
            Object.entries(data.filters).map(([column, value]) => [`f.${column}`, String(value)]),
          ),
        }}
      />
    </>
  );
}
