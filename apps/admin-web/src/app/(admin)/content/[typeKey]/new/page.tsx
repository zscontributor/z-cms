import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  can,
  getContent,
  getContentTypeByKey,
  getCurrentSite,
  getSession,
  listContentTypes,
} from "@/lib/api";
import { ContentEditor, type EditorInitial } from "@/components/editor/content-editor";
import { PageHeader } from "@/components/page-header";
import { getT } from "@/lib/locale";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ typeKey: string }>;
  /**
   * `?translationOf=<id>&locale=<code>` — this new document is the translation of
   * an existing one. Both are needed: the id says which page, the locale says
   * which language, and neither can be inferred from the other.
   */
  searchParams: Promise<{ translationOf?: string; locale?: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { typeKey } = await params;
  const [t, type] = await Promise.all([getT(), getContentTypeByKey(typeKey)]);
  return {
    title: type
      ? t("content.new.metaTitle", { type: type.name.toLowerCase() })
      : t("content.new.metaFallback"),
  };
}

export default async function NewContentPage({ params, searchParams }: PageProps) {
  const { typeKey } = await params;
  const { translationOf, locale: targetLocale } = await searchParams;
  const t = await getT();
  // `listContentTypes` is the same cached call `getContentTypeByKey` resolves the
  // URL key through, so asking for the whole set costs no second request. A
  // `core/content-list` block needs it to offer the site's types as a choice.
  const [user, type, site, contentTypes] = await Promise.all([
    getSession(),
    getContentTypeByKey(typeKey),
    getCurrentSite(),
    listContentTypes(),
  ]);

  if (!type) notFound();

  if (!can(user, "content:create")) {
    return <div className="z-card p-10 text-center text-sm">{t("content.new.denied")}</div>;
  }

  const defaults: Record<string, unknown> = {};
  for (const field of type.fields) {
    if (field.defaultValue !== undefined) defaults[field.key] = field.defaultValue;
  }

  // Translating an existing page.
  //
  // The source is loaded and its *structure* copied — blocks, typed fields, SEO —
  // with the text left in the original language for the translator to work over.
  // A blank editor would be the wrong starting point: the translator's job is to
  // translate a page, not to rebuild it, and rebuilding it by hand is how a
  // translation ends up with different blocks from the page it translates.
  //
  // The slug is deliberately NOT copied. "/vi/about" is not a Vietnamese URL.
  const locales = site?.locales?.length ? site.locales : ["vi"];
  const fallbackLocale = site?.defaultLocale ?? locales[0] ?? "en";
  const selectedLocale = locales.includes(targetLocale ?? "")
    ? targetLocale!
    : fallbackLocale;

  const source =
    translationOf && targetLocale && site?.locales?.includes(targetLocale)
      ? await getContent(translationOf).catch(() => null)
      : null;

  // A source of another type would carry a field set this editor cannot render.
  const translating = source?.contentType.key === typeKey ? source : null;

  const initial: EditorInitial = translating
    ? {
        title: translating.title,
        slug: "",
        locale: selectedLocale,
        translationGroupId: translating.translationGroupId,
        excerpt: translating.excerpt ?? "",
        status: "DRAFT",
        data: translating.data ?? defaults,
        blocks: translating.blocks ?? [],
        seo: {},
      }
    : {
        title: "",
        slug: "",
        // The site's default, never a constant: an entry filed under a language
        // the site does not publish is served at a URL that does not resolve.
        locale: selectedLocale,
        excerpt: "",
        status: "DRAFT",
        data: defaults,
        blocks: [],
        seo: {},
      };

  return (
    <>
      <PageHeader
        title={
          translating
            ? t("content.new.translating", { title: translating.title })
            : t("content.new.metaTitle", { type: type.name.toLowerCase() })
        }
        description={
          <>
            <Link href={`/content/${type.key}`} className="hover:underline">
              {type.pluralName}
            </Link>{" "}
            ·{" "}
            {translating ? (
              <Link
                href={`/content/${type.key}/${translating.id}`}
                className="hover:underline"
              >
                {t("content.new.translationOf", { locale: translating.locale })}
              </Link>
            ) : (
              t("content.new.draft")
            )}
          </>
        }
      />
      {!translating && locales.length > 1 ? (
        <div
          className="mb-4 flex w-fit items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--surface-sunken)] p-1"
          role="tablist"
          aria-label={t("content.list.languageTabs")}
        >
          {locales.map((value) => {
            const active = value === selectedLocale;
            const name =
              new Intl.DisplayNames([selectedLocale], { type: "language" }).of(value) ??
              value;
            return (
              <Link
                key={value}
                href={`/content/${type.key}/new?locale=${encodeURIComponent(value)}`}
                role="tab"
                aria-selected={active}
                className={
                  active
                    ? "inline-flex h-7 items-center rounded bg-[var(--surface-raised)] px-2.5 text-xs font-medium shadow-sm"
                    : "inline-flex h-7 items-center rounded px-2.5 text-xs font-medium z-muted hover:text-[var(--foreground)]"
                }
              >
                {name}
              </Link>
            );
          })}
        </div>
      ) : null}
      <ContentEditor
        type={type}
        initial={initial}
        contentTypes={contentTypes.map(({ key, name }) => ({ key, name }))}
        permissions={{
          canSave: true,
          canPublish: can(user, "content:publish"),
          canDelete: false,
        }}
      />
    </>
  );
}
