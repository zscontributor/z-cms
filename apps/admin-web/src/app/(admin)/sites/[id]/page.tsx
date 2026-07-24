import Link from "next/link";
import { notFound } from "next/navigation";
import { SWITCHER_LOCALES } from "@zcmsorg/i18n";
import { can, getSession, listSites } from "@/lib/api";
import { getT } from "@/lib/locale";
import { SiteForm } from "./site-form";

/**
 * One site: its name, its brand, and whether it is published.
 *
 * The site is taken from the tenant's own list rather than fetched by id. It is
 * the same request the sidebar already made, so it costs nothing — and a site that
 * is not in the list is not one this user may see, which makes "not yours" and
 * "does not exist" the same 404 without a second round trip to prove it.
 */
export default async function SitePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const t = await getT();

  const [user, sites] = await Promise.all([getSession(), listSites()]);
  const site = sites.find((candidate) => candidate.id === id);
  if (!site) notFound();

  const canUpdate = user ? can(user, "site:update") : false;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/sites" className="text-xs z-muted hover:underline">
          ← {t("admin.sites.title")}
        </Link>
        <h1 className="mt-1 text-lg font-semibold">{site.name}</h1>
        <p className="mt-0.5 text-sm z-muted">
          {site.domains.map((domain) => domain.hostname).join(", ")}
        </p>
      </div>

      <SiteForm site={site} canUpdate={canUpdate} locales={SWITCHER_LOCALES} />
    </div>
  );
}
