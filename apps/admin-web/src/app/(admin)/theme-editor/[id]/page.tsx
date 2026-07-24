import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { MenuDto } from "@zcmsorg/schemas";
import {
  can,
  getCurrentSite,
  getSession,
  getThemeDraft,
  listContentTypes,
  listMenus,
} from "@/lib/api";
import { ThemeEditor } from "@/components/theme-editor/theme-editor";
import { getLocale, getT } from "@/lib/locale";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("themeEditor.metaTitle") };
}

// The editor is a live surface over one row; a cached shell would open somebody
// else's last drawing.
export const dynamic = "force-dynamic";

export default async function ThemeEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const t = await getT();
  const user = await getSession();

  if (!can(user, "theme:author")) {
    return <div className="z-card p-10 text-center text-sm">{t("themeEditor.errors.denied")}</div>;
  }

  const { id } = await params;
  const locale = await getLocale();

  const draft = await getThemeDraft(id).catch(() => null);
  if (!draft) notFound();

  const [site, contentTypes, menus] = await Promise.all([
    getCurrentSite(),
    listContentTypes().catch(() => []),
    // A site with no menu is a normal state, and the canvas draws a menu widget as
    // nothing rather than failing to load.
    listMenus().catch((): MenuDto[] => []),
  ]);

  return (
    <ThemeEditor
      draft={draft}
      // Resolved against the site's REAL types: a binding typed by hand against a
      // type this site does not define is a list that is silently, permanently empty.
      contentTypes={contentTypes.map((type) => ({ key: type.key, name: type.name }))}
      menus={menus}
      siteName={site?.name ?? ""}
      locale={locale}
      canEdit
      canPublish={can(user, "theme:publish")}
    />
  );
}
