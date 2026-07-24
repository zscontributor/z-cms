import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ApiError,
  can,
  getContent,
  getContentTranslations,
  getContentTypeByKey,
  getSession,
  listContentTypes,
} from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { ContentEditor, type EditorInitial } from "@/components/editor/content-editor";
import { TranslationsPanel } from "@/components/editor/translations-panel";
import { PageHeader } from "@/components/page-header";
import { STATUS_TONES, statusKey } from "@/lib/format";
import { getT } from "@/lib/locale";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ typeKey: string; id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  try {
    const content = await getContent(id);
    return { title: content.title };
  } catch {
    return { title: (await getT())("content.metaFallback") };
  }
}

export default async function EditContentPage({ params }: PageProps) {
  const { typeKey, id } = await params;

  const t = await getT();
  // `listContentTypes` is the same cached call `getContentTypeByKey` resolves the
  // URL key through, so asking for the whole set costs no second request. A
  // `core/content-list` block needs it to offer the site's types as a choice.
  const [user, type, contentTypes] = await Promise.all([
    getSession(),
    getContentTypeByKey(typeKey),
    listContentTypes(),
  ]);
  if (!type) notFound();

  let content;
  try {
    content = await getContent(id);
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 400)) notFound();
    throw error;
  }

  // A content id from another type (a hand-edited URL) must not silently render
  // with the wrong field set.
  if (content.contentType.key !== typeKey) notFound();

  // After the content, not alongside it: this needs the id to have resolved, and
  // it must not delay the editor for a site that has one language.
  const translations = await getContentTranslations(content.id);

  const initial: EditorInitial = {
    id: content.id,
    title: content.title,
    slug: content.slug,
    locale: content.locale,
    excerpt: content.excerpt ?? "",
    status: content.status,
    data: content.data ?? {},
    blocks: content.blocks ?? [],
    seo: content.seo ?? {},
    path: content.path,
    updatedAt: content.updatedAt,
  };

  return (
    <>
      <PageHeader
        title={content.title || t("content.editor.untitled")}
        description={
          <>
            <Link href={`/content/${type.key}`} className="hover:underline">
              {type.pluralName}
            </Link>{" "}
            · <code className="font-mono">{content.path || "/"}</code>
          </>
        }
        actions={
          <Badge tone={STATUS_TONES[content.status]}>{t(statusKey(content.status))}</Badge>
        }
      />
      <TranslationsPanel
        type={type}
        translations={translations}
        sourceId={content.id}
        currentLocale={content.locale}
      />
      <ContentEditor
        type={type}
        initial={initial}
        contentTypes={contentTypes.map(({ key, name }) => ({ key, name }))}
        permissions={{
          canSave: can(user, "content:update"),
          canPublish: can(user, "content:publish"),
          canDelete: can(user, "content:delete"),
        }}
      />
    </>
  );
}
