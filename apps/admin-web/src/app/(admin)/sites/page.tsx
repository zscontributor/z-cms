import Link from "next/link";
import { SWITCHER_LOCALES } from "@zcmsorg/i18n";
import { can, getSession, listSites } from "@/lib/api";
import { getT } from "@/lib/locale";
import { SiteCreateForm } from "./site-create-form";

/**
 * Every site in the tenant, and the form that makes another one.
 *
 * The list is not site-scoped — it is the one screen that is ABOUT the sites
 * rather than about the contents of one, so it ignores the current-site cookie
 * entirely.
 */
export default async function SitesPage() {
  const t = await getT();
  const [user, sites] = await Promise.all([getSession(), listSites()]);

  const canCreate = user ? can(user, "site:create") : false;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">{t("admin.sites.title")}</h1>
        <p className="mt-0.5 text-sm z-muted">{t("admin.sites.subtitle")}</p>
      </div>

      {sites.length === 0 ? (
        <p className="z-card p-5 text-sm z-muted">{t("admin.sites.empty")}</p>
      ) : (
        <div className="z-card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b border-[var(--border)] text-left text-[11px] uppercase tracking-wider z-muted">
              <tr>
                <th className="px-4 py-2.5 font-medium">{t("admin.sites.name")}</th>
                <th className="px-4 py-2.5 font-medium">{t("admin.sites.status")}</th>
                <th className="px-4 py-2.5 font-medium">{t("admin.sites.domains")}</th>
                <th className="px-4 py-2.5 font-medium">{t("admin.sites.theme")}</th>
                <th className="px-4 py-2.5 font-medium">{t("admin.sites.brand")}</th>
              </tr>
            </thead>
            <tbody>
              {sites.map((site) => (
                <tr
                  key={site.id}
                  className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--surface-sunken)]"
                >
                  <td className="px-4 py-2.5">
                    <Link href={`/sites/${site.id}`} className="font-medium hover:underline">
                      {site.name}
                    </Link>
                    <span className="ml-2 text-xs z-muted">{site.slug}</span>
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={
                        site.status === "PUBLISHED"
                          ? "rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-700 dark:text-emerald-300"
                          : "rounded-full bg-[var(--surface-sunken)] px-2 py-0.5 text-xs z-muted"
                      }
                    >
                      {site.status}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-xs z-muted">
                    {site.domains.map((domain) => domain.hostname).join(", ") || "—"}
                  </td>
                  <td className="px-4 py-2.5 text-xs z-muted">
                    {site.activeTheme?.name ?? t("admin.sites.noTheme")}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className="size-4 shrink-0 rounded border border-[var(--border-strong)]"
                        style={{ background: site.brand.primaryColor }}
                      />
                      {site.brand.logo ? (
                        <img
                          src={site.brand.logo}
                          alt=""
                          className="h-5 max-w-24 object-contain"
                        />
                      ) : (
                        <span className="text-xs z-muted">{t("admin.sites.noLogo")}</span>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Creating a site claims a hostname across the whole platform, which is why
          it is an OWNER's act and not an ADMIN's — see `site:create`. */}
      {canCreate ? <SiteCreateForm locales={SWITCHER_LOCALES} /> : null}
    </div>
  );
}
