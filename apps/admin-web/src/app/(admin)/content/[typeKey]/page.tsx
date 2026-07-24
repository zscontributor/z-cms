import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ContentStatusSchema } from "@zcmsorg/schemas";
import {
  can,
  getContentTypeByKey,
  getCurrentSite,
  getSession,
  listContents,
} from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { EmptyState, TBody, TD, TH, THead, TR, Table } from "@/components/ui/table";
import { PageHeader } from "@/components/page-header";
import { Pagination } from "@/components/pagination";
import { Icon } from "@/components/shell/icon";
import { STATUS_TONES, formatDateTime, statusKey } from "@/lib/format";
import { getLocale, getT } from "@/lib/locale";
import { ListToolbar } from "./list-toolbar";
import { RowActions } from "./row-actions";

export const dynamic = "force-dynamic";

const PER_PAGE = 20;

interface PageProps {
  params: Promise<{ typeKey: string }>;
  searchParams: Promise<{ page?: string; status?: string; q?: string; locale?: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { typeKey } = await params;
  const [t, type] = await Promise.all([getT(), getContentTypeByKey(typeKey)]);
  return { title: type?.pluralName ?? t("content.metaFallback") };
}

export default async function ContentListPage({ params, searchParams }: PageProps) {
  const { typeKey } = await params;
  const { page: pageParam, status: statusParam, q, locale: localeParam } = await searchParams;

  const t = await getT();
  const locale = await getLocale();
  const [user, type, site] = await Promise.all([
    getSession(),
    getContentTypeByKey(typeKey),
    getCurrentSite(),
  ]);
  if (!type) notFound();
  if (!can(user, "content:read")) {
    return (
      <div className="z-card p-10 text-center text-sm">{t("content.list.denied")}</div>
    );
  }

  const page = Math.max(1, Number.parseInt(pageParam ?? "1", 10) || 1);
  const status = ContentStatusSchema.safeParse(statusParam).success ? statusParam : undefined;
  const locales = site?.locales?.length ? site.locales : ["vi"];
  const fallbackLocale = site?.defaultLocale ?? locales[0] ?? "en";
  const selectedLocale = locales.includes(localeParam ?? "")
    ? localeParam!
    : fallbackLocale;

  const result = await listContents({
    contentTypeKey: typeKey,
    status,
    locale: selectedLocale,
    search: q,
    page,
    perPage: PER_PAGE,
  });

  /**
   * A singleton has exactly one document (a homepage, an "about us" page).
   * Sending the user to a one-row list would be a pointless click, so jump
   * straight into the editor — creating the document if it does not exist yet.
   */
  if (type.isSingleton && !q && !status) {
    const existing = result.items[0];
    redirect(
      `/content/${typeKey}/${existing ? existing.id : "new"}${
        existing ? "" : `?locale=${encodeURIComponent(selectedLocale)}`
      }`,
    );
  }

  const canCreate = can(user, "content:create");

  return (
    <>
      <PageHeader
        title={type.pluralName}
        description={
          type.description ??
          t("content.list.description", { type: type.pluralName.toLowerCase() })
        }
        actions={
          canCreate ? (
            <LinkButton
              href={`/content/${typeKey}/new?locale=${encodeURIComponent(selectedLocale)}`}
              variant="primary"
            >
              <Icon name="plus" size={18} />
              {t("content.list.create")}
            </LinkButton>
          ) : null
        }
      />

      <ListToolbar typeKey={typeKey} locales={locales} selectedLocale={selectedLocale} />

      {result.items.length === 0 ? (
        <div className="z-card">
          <EmptyState
            title={
              q || status ? t("content.list.noResultsTitle") : t("content.list.emptyTitle")
            }
            description={
              q || status
                ? t("content.list.noResultsDescription")
                : t("content.list.emptyDescription", { type: type.name.toLowerCase() })
            }
            action={
              canCreate && !q && !status ? (
                <LinkButton
                  href={`/content/${typeKey}/new?locale=${encodeURIComponent(selectedLocale)}`}
                  variant="primary"
                  size="sm"
                >
                  {t("content.list.createType", { type: type.name.toLowerCase() })}
                </LinkButton>
              ) : null
            }
          />
        </div>
      ) : (
        <>
          <Table>
            <THead>
              <TR>
                <TH>{t("content.table.title")}</TH>
                <TH className="w-40">{t("content.table.status")}</TH>
                <TH className="w-56">{t("content.table.path")}</TH>
                <TH className="w-44">{t("content.table.updated")}</TH>
                <TH className="w-52 text-right">{t("content.table.actions")}</TH>
              </TR>
            </THead>
            <TBody>
              {result.items.map((item) => (
                <TR key={item.id}>
                  <TD>
                    <Link
                      href={`/content/${typeKey}/${item.id}`}
                      className="font-medium hover:text-brand-600 dark:hover:text-brand-400"
                    >
                      {item.title}
                    </Link>
                    {item.excerpt ? (
                      <p className="mt-0.5 line-clamp-1 text-[11px] z-muted">{item.excerpt}</p>
                    ) : null}
                  </TD>
                  <TD>
                    <Badge tone={STATUS_TONES[item.status]}>{t(statusKey(item.status))}</Badge>
                  </TD>
                  <TD>
                    <code className="text-[11px] z-muted">{item.path || "/"}</code>
                  </TD>
                  <TD className="text-[11px] z-muted">
                    {formatDateTime(item.updatedAt, locale)}
                    {item.author ? <div className="truncate">{item.author.name}</div> : null}
                  </TD>
                  <TD>
                    <RowActions
                      content={item}
                      typeKey={typeKey}
                      canPublish={can(user, "content:publish")}
                      canDelete={can(user, "content:delete")}
                    />
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>

          <Pagination
            page={result.page}
            totalPages={result.totalPages}
            total={result.total}
            basePath={`/content/${typeKey}`}
            query={{ q, status, locale: selectedLocale }}
          />
        </>
      )}
    </>
  );
}
