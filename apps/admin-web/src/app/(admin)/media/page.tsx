import type { Metadata } from "next";
import Link from "next/link";
import { can, getSession, listMedia, listMediaFolders } from "@/lib/api";
import { EmptyState } from "@/components/ui/table";
import { PageHeader } from "@/components/page-header";
import { Pagination } from "@/components/pagination";
import { Icon } from "@/components/shell/icon";
import { getLocale, getT } from "@/lib/locale";
import { FileGrid } from "./file-grid";
import { FolderGrid } from "./folder-grid";
import { ancestorsOf } from "./folder-tree";
import { LibraryToolbar } from "./library-toolbar";
import { Uploader } from "./uploader";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("media.metaTitle") };
}

export const dynamic = "force-dynamic";

const PER_PAGE = 24;

export default async function MediaPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; q?: string; kind?: string; folder?: string }>;
}) {
  const { page: pageParam, q, kind, folder } = await searchParams;
  const t = await getT();
  const locale = await getLocale();
  const user = await getSession();

  if (!can(user, "media:read")) {
    return <div className="z-card p-10 text-center text-sm">{t("media.denied")}</div>;
  }

  const canUpload = can(user, "media:upload");
  const canUpdate = can(user, "media:update");
  const canDelete = can(user, "media:delete");

  const page = Math.max(1, Number.parseInt(pageParam ?? "1", 10) || 1);
  const search = q?.trim() || undefined;
  const mediaKind = kind === "image" || kind === "document" ? kind : undefined;

  // Searching leaves the tree behind and looks at the whole library; browsing
  // stays in one folder ("root" when none is open). The two are different
  // queries, and conflating them would make search unable to find anything the
  // user had not already navigated to.
  const currentFolderId = search ? null : folder ?? null;

  const [folders, result] = await Promise.all([
    listMediaFolders(),
    listMedia({
      page,
      perPage: PER_PAGE,
      search,
      kind: mediaKind,
      folder: search ? undefined : currentFolderId ?? "root",
    }),
  ]);

  const trail = ancestorsOf(folders, currentFolderId);
  const currentFolder = trail.at(-1) ?? null;

  return (
    <>
      <PageHeader
        title={t("media.title")}
        description={t("media.description", { count: result.total })}
      />

      <LibraryToolbar />

      {search ? (
        <p className="mb-3 flex items-center gap-2 text-xs z-muted">
          <span>{t("media.list.searchingAll", { term: search })}</span>
          <Link href="/media" className="text-brand-500 hover:underline">
            {t("media.list.clearSearch")}
          </Link>
        </p>
      ) : (
        <>
          <nav aria-label={t("media.folders.breadcrumb")} className="mb-3 flex flex-wrap items-center gap-1 text-xs">
            <Link
              href="/media"
              className={
                currentFolder ? "z-muted hover:text-[var(--text)]" : "font-medium text-[var(--text)]"
              }
            >
              {t("media.folders.root")}
            </Link>
            {trail.map((folder, index) => (
              <span key={folder.id} className="flex items-center gap-1">
                <Icon name="right" size={12} className="z-muted" />
                <Link
                  href={`/media?folder=${folder.id}`}
                  className={
                    index === trail.length - 1
                      ? "font-medium text-[var(--text)]"
                      : "z-muted hover:text-[var(--text)]"
                  }
                >
                  {folder.name}
                </Link>
              </span>
            ))}
          </nav>

          <FolderGrid
            folders={folders}
            currentId={currentFolderId}
            canManage={canUpdate}
            canDelete={canDelete}
          />
        </>
      )}

      {canUpload && !search ? <Uploader folderId={currentFolderId} /> : null}

      {result.items.length === 0 ? (
        <div className="z-card">
          <EmptyState
            title={search ? t("media.noResultsTitle") : t("media.emptyTitle")}
            description={
              search ? t("media.noResultsDescription") : t("media.emptyDescription")
            }
          />
        </div>
      ) : (
        <>
          <FileGrid
            items={result.items}
            folders={folders}
            locale={locale}
            canUpdate={canUpdate}
            canDelete={canDelete}
          />

          <Pagination
            page={result.page}
            totalPages={result.totalPages}
            total={result.total}
            basePath="/media"
            query={{ q: search, kind: mediaKind, folder: currentFolder?.id }}
          />
        </>
      )}
    </>
  );
}
