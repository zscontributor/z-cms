import { redirect } from "next/navigation";
import { can, getCurrentSite, getSession, listContents, listMenus } from "@/lib/api";
import { getT } from "@/lib/locale";
import { PageHeader } from "@/components/page-header";
import { MenusManager, type PageOption } from "./menus-manager";

/**
 * Manage the site's navigation menus.
 *
 * The theme renders each menu location (primary, footer, …) as a tree of links.
 * A menu can arrive from the active theme's demo; saving a location here makes it
 * the site's own — cms-api then stops letting the demo shadow it.
 */
export default async function MenusPage() {
  const user = await getSession();
  if (!user) redirect("/login");
  if (!can(user, "menu:read")) redirect("/");

  const t = await getT();
  const menus = await listMenus();

  // Suggestions for the URL field: this site's published pages, in the DEFAULT
  // locale (menu URLs are the default-locale path; cms-api localises the rest).
  // Never let a failed suggestion query take the page down.
  let pages: PageOption[] = [];
  try {
    const site = await getCurrentSite();
    const locale = site?.defaultLocale;
    const res = await listContents({ status: "PUBLISHED", locale, perPage: 100 });
    const seen = new Set<string>();
    pages = res.items
      .filter((c) => typeof c.path === "string" && !seen.has(c.path) && (seen.add(c.path), true))
      .map((c) => ({ path: c.path, title: c.title }))
      .sort((a, b) => a.path.localeCompare(b.path));
  } catch {
    pages = [];
  }

  const canManage = can(user, "menu:manage");

  return (
    <>
      <PageHeader title={t("admin.menus.title")} description={t("admin.menus.description")} />
      <MenusManager menus={menus} pages={pages} canManage={canManage} />
    </>
  );
}
