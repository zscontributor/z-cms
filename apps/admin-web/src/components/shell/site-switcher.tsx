"use client";

import { useEffect, useState } from "react";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import type { SiteDto } from "@zcmsorg/schemas";
import { switchSiteAction } from "@/app/actions/site";
import { Select } from "@/components/ui/field";
import { Icon } from "@/components/shell/icon";
import { useT } from "@/lib/i18n-provider";

/** Build the public URL for a site from its primary domain (localhost stays http). */
function publicSiteUrl(site: SiteDto | undefined): string | null {
  const host = site?.domains.find((d) => d.isPrimary)?.hostname ?? site?.domains[0]?.hostname;
  if (!host) return null;
  const scheme = /^localhost(:|$)/.test(host) ? "http" : "https";
  return `${scheme}://${host}`;
}

/**
 * The selected site is a cookie, not a URL segment: it has to survive a
 * navigation to any screen, and every API call already carries it as a header.
 * Changing it submits — no client state to keep in sync.
 */
export function SiteSwitcher({
  sites,
  currentSiteId,
}: {
  sites: SiteDto[];
  currentSiteId: string | null;
}) {
  const t = useT();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const fallbackSiteId = currentSiteId ?? sites[0]?.id ?? "";
  const [selectedSiteId, setSelectedSiteId] = useState(fallbackSiteId);

  useEffect(() => {
    setSelectedSiteId(fallbackSiteId);
  }, [fallbackSiteId]);

  if (sites.length === 0) {
    return <span className="text-xs z-muted">{t("admin.siteSwitcher.empty")}</span>;
  }

  const openUrl = publicSiteUrl(sites.find((site) => site.id === selectedSiteId));

  return (
    <div className="flex items-center gap-2">
      <label htmlFor="site-switcher" className="text-[11px] uppercase tracking-wider z-muted">
        {t("admin.siteSwitcher.label")}
      </label>
      <Select
        id="site-switcher"
        name="siteId"
        value={selectedSiteId}
        disabled={pending || sites.length === 1}
        onChange={(event) => {
          const siteId = event.currentTarget.value;
          setSelectedSiteId(siteId);
          startTransition(async () => {
            await switchSiteAction(siteId);
            router.replace("/");
            router.refresh();
          });
        }}
        className="h-8 w-52 py-1 text-xs"
      >
        {sites.map((site) => (
          <option key={site.id} value={site.id}>
            {site.name}
          </option>
        ))}
      </Select>
      {openUrl && (
        <a
          href={openUrl}
          target="_blank"
          rel="noreferrer noopener"
          title={t("admin.siteSwitcher.openSite")}
          className="inline-flex h-8 items-center gap-1.5 rounded px-2 text-xs font-medium text-brand-600 hover:bg-black/5 dark:text-brand-400 dark:hover:bg-white/10"
        >
          <Icon name="external" size={16} />
          {t("admin.siteSwitcher.openSite")}
        </a>
      )}
    </div>
  );
}
