import type { Metadata } from "next";
import Link from "next/link";
import type { ContentDto } from "@zcmsorg/schemas";
import {
  can,
  getCurrentSite,
  getSession,
  listContentTypes,
  listContents,
} from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { PageHeader } from "@/components/page-header";
import { Icon } from "@/components/shell/icon";
import { STATUS_TONES, formatDateTime, statusKey } from "@/lib/format";
import { getLocale, getT } from "@/lib/locale";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("admin.dashboard.metaTitle") };
}

export const dynamic = "force-dynamic";

interface TypeStat {
  key: string;
  name: string;
  pluralName: string;
  icon: string;
  total: number;
  published: number;
  drafts: number;
}

export default async function DashboardPage() {
  const t = await getT();
  const locale = await getLocale();
  const user = await getSession();
  const site = await getCurrentSite();

  if (!site) {
    return (
      <div className="z-card p-10 text-center">
        <p className="text-sm font-medium">{t("admin.dashboard.noSiteTitle")}</p>
        <p className="mt-1 text-xs z-muted">{t("admin.dashboard.noSiteDescription")}</p>
      </div>
    );
  }

  const types = can(user, "content:read") ? await listContentTypes() : [];

  const stats: TypeStat[] = await Promise.all(
    types.map(async (type) => {
      const [all, published] = await Promise.all([
        listContents({ contentTypeKey: type.key, perPage: 1 }),
        listContents({ contentTypeKey: type.key, status: "PUBLISHED", perPage: 1 }),
      ]);
      return {
        key: type.key,
        name: type.name,
        pluralName: type.pluralName,
        icon: type.icon ?? "doc",
        total: all.total,
        published: published.total,
        drafts: Math.max(all.total - published.total, 0),
      };
    }),
  );

  const recent: ContentDto[] =
    types.length > 0 ? (await listContents({ perPage: 6 })).items : [];

  const totalContent = stats.reduce((sum, stat) => sum + stat.total, 0);
  const totalPublished = stats.reduce((sum, stat) => sum + stat.published, 0);

  return (
    <>
      <PageHeader
        title={t("admin.dashboard.greeting", {
          name: user?.name.split(" ").slice(-1)[0] ?? "",
        })}
        description={t("admin.dashboard.summary", {
          site: site.name,
          total: totalContent,
          published: totalPublished,
        })}
        actions={
          site.activeTheme ? (
            <Badge tone="info">
              {t("admin.dashboard.activeTheme", { name: site.activeTheme.name })}
            </Badge>
          ) : (
            <Badge tone="warning">{t("admin.dashboard.noTheme")}</Badge>
          )
        }
      />

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((stat) => (
          <Link
            key={stat.key}
            href={`/content/${stat.key}`}
            className="z-card group p-4 transition-colors hover:border-brand-300 dark:hover:border-brand-500/50"
          >
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-xs font-medium z-muted">
                <Icon name={stat.icon} size={18} />
                {stat.pluralName}
              </span>
              <Icon
                name="external"
                size={16}
                className="opacity-0 transition-opacity group-hover:opacity-60"
              />
            </div>
            <p className="mt-2 text-2xl font-semibold tabular-nums">{stat.total}</p>
            <p className="mt-1 text-[11px] z-muted">
              {t("admin.dashboard.typeCounts", {
                published: stat.published,
                drafts: stat.drafts,
              })}
            </p>
          </Link>
        ))}

        {stats.length === 0 ? (
          <div className="z-card p-4 text-xs z-muted sm:col-span-2 xl:col-span-4">
            {t("admin.dashboard.noTypes")}
          </div>
        ) : null}
      </section>

      <section className="mt-5 grid gap-4 lg:grid-cols-[2fr_1fr]">
        <div className="z-card overflow-hidden">
          <header className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2.5">
            <h2 className="text-sm font-semibold">{t("admin.dashboard.recent")}</h2>
          </header>
          {recent.length === 0 ? (
            <p className="px-4 py-10 text-center text-xs z-muted">
              {t("admin.dashboard.recentEmpty")}
            </p>
          ) : (
            <ul>
              {recent.map((item) => (
                <li key={item.id} className="border-b border-[var(--border)] last:border-b-0">
                  <Link
                    href={`/content/${item.contentType.key}/${item.id}`}
                    className="flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--surface-sunken)]"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">{item.title}</span>
                      <span className="block truncate text-[11px] z-muted">
                        {item.contentType.name} · {formatDateTime(item.updatedAt, locale)}
                      </span>
                    </span>
                    <Badge tone={STATUS_TONES[item.status]}>{t(statusKey(item.status))}</Badge>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="z-card p-4">
          <h2 className="text-sm font-semibold">{t("admin.dashboard.shortcuts")}</h2>
          <div className="mt-3 flex flex-col gap-2">
            {can(user, "content:create")
              ? types
                  .filter((type) => !type.isSingleton)
                  .slice(0, 3)
                  .map((type) => (
                    <LinkButton key={type.key} href={`/content/${type.key}/new`}>
                      <Icon name="plus" size={18} />
                      {t("admin.dashboard.createType", { type: type.name.toLowerCase() })}
                    </LinkButton>
                  ))
              : null}
            {can(user, "media:read") ? (
              <LinkButton href="/media">
                <Icon name="image" size={18} />
                {t("admin.nav.media")}
              </LinkButton>
            ) : null}
            {can(user, "theme:read") ? (
              <LinkButton href="/appearance">
                <Icon name="palette" size={18} />
                {t("admin.nav.appearance")}
              </LinkButton>
            ) : null}
          </div>

          <dl className="mt-5 space-y-2 border-t border-[var(--border)] pt-4 text-xs">
            <div className="flex justify-between gap-2">
              <dt className="z-muted">{t("admin.dashboard.domain")}</dt>
              <dd className="truncate font-medium">
                {site.domains.find((d) => d.isPrimary)?.hostname ??
                  site.domains[0]?.hostname ??
                  "—"}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="z-muted">{t("admin.dashboard.languages")}</dt>
              <dd className="font-medium">{site.locales.join(", ") || site.defaultLocale}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="z-muted">{t("admin.dashboard.status")}</dt>
              <dd className="font-medium">{site.status}</dd>
            </div>
          </dl>
        </div>
      </section>
    </>
  );
}
