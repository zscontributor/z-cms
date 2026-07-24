import { redirect } from "next/navigation";
import type { ContentTypeDto } from "@zcmsorg/schemas";
import { can, getCurrentSite, getSession, listContentTypes, listSites } from "@/lib/api";
import { getT } from "@/lib/locale";
import { Sidebar, type NavGroup } from "@/components/shell/sidebar";
import { Topbar } from "@/components/shell/topbar";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getSession();
  if (!user) redirect("/login");

  const t = await getT();
  const [sites, site] = await Promise.all([safe(listSites, []), safe(getCurrentSite, null)]);

  // A site with no content types (or an API hiccup) must still render the shell,
  // otherwise the user is locked out of the very screens that would fix it.
  const contentTypes: ContentTypeDto[] = site ? await safe(listContentTypes, []) : [];

  const groups: NavGroup[] = [
    {
      label: t("admin.nav.overview"),
      items: [{ href: "/", label: t("admin.nav.dashboard"), icon: "grid" }],
    },
    {
      label: t("admin.nav.content"),
      items: can(user, "content:read")
        ? contentTypes.map((type) => ({
            href: `/content/${type.key}`,
            label: type.pluralName,
            icon: type.icon ?? "doc",
          }))
        : [],
    },
    {
      label: t("admin.nav.library"),
      items: [
        ...(can(user, "media:read")
          ? [{ href: "/media", label: t("admin.nav.media"), icon: "image" as const }]
          : []),
        ...(can(user, "theme:read")
          ? [{ href: "/appearance", label: t("admin.nav.appearance"), icon: "palette" as const }]
          : []),
        ...(can(user, "plugin:read")
          ? [{ href: "/plugins", label: t("admin.nav.plugins"), icon: "plug" as const }]
          : []),
        // The catalogue a site owner installs FROM. Gated on theme:read — the
        // lowest read scope any package touches — because browsing is harmless;
        // the install buttons inside are each gated on their own scope.
        ...(can(user, "theme:read")
          ? [
              {
                href: "/marketplace",
                label: t("admin.nav.marketplace"),
                icon: "marketplace" as const,
              },
            ]
          : []),
      ],
    },
    {
      label: t("admin.nav.operations"),
      items: [
        // `user:read` is the lowest of the three user permissions, and the only
        // one that decides whether the screen is worth opening at all. What an
        // ADMIN may do once inside (invite, but not demote or remove) is gated on
        // the page itself — a nav item cannot express "half of this".
        // `site:read` is held by every role, so this is in everyone's sidebar. That
        // is deliberate: the screen shows the site's brand and whether it is
        // published — facts an EDITOR is better off being able to see than to guess
        // at. The create form and the save buttons inside are each gated on their
        // own permission, and render read-only without it.
        ...(can(user, "site:read")
          ? [{ href: "/sites", label: t("admin.nav.sites"), icon: "globe" as const }]
          : []),
        ...(can(user, "user:read")
          ? [{ href: "/users", label: t("admin.nav.users"), icon: "users" as const }]
          : []),
        ...(can(user, "settings:update")
          ? [
              { href: "/jobs", label: t("admin.nav.jobs"), icon: "jobs" as const },
              // Gated on settings:update, not settings:read. A VIEWER may *read*
              // the configuration through the API, and the page renders read-only
              // for them if they navigate to it — but an operations screen in the
              // sidebar of someone who cannot operate anything is just noise.
              { href: "/settings/mail", label: t("admin.nav.mail"), icon: "mail" as const },
            ]
          : []),
      ],
    },
  ].filter((group) => group.items.length > 0);

  return (
    <div className="flex min-h-screen">
      <Sidebar
        groups={groups}
        siteName={site?.name ?? t("admin.sidebar.noSite")}
        siteLabel={t("admin.sidebar.currentSite")}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar user={user} sites={sites} currentSiteId={site?.id ?? null} />
        <main className="min-w-0 flex-1 px-6 py-6">{children}</main>
      </div>
    </div>
  );
}

/** The shell is not the place to blow up: degrade to an empty list. */
async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}
