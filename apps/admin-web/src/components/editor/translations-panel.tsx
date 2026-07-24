import Link from "next/link";
import type { ContentTypeDto, TranslationDto } from "@zcmsorg/schemas";
import { Badge } from "@/components/ui/badge";
import { Flag } from "@/components/shell/flag";
import { Icon } from "@/components/shell/icon";
import { getT } from "@/lib/locale";
import { STATUS_TONES, statusKey } from "@/lib/format";

/**
 * Every language the site publishes in, and this page in each of them.
 *
 * The panel lists locales, not translations — including the ones with nothing in
 * them. That is the whole reason it exists: an author needs to see the *gap*
 * ("Vietnamese — not translated") as something they can click, and a list of what
 * already exists cannot show what is missing.
 *
 * Nothing is rendered on a single-language site. A panel offering to translate a
 * page into the only language there is would be furniture.
 *
 * The "Translate" link does not create anything. It opens the new-content editor
 * carrying the source page's id, so the author writes the translation and *then*
 * saves it — an empty draft created by a click, which is what a "create" button
 * here would produce, is a page somebody has to remember to delete.
 */
export async function TranslationsPanel({
  type,
  translations,
  sourceId,
  currentLocale,
}: {
  type: ContentTypeDto;
  translations: TranslationDto[];
  sourceId: string;
  currentLocale: string;
}) {
  if (translations.length < 2) return null;

  const t = await getT();
  const languageName = new Intl.DisplayNames(["en"], { type: "language" });

  return (
    <section className="z-card p-4">
      <h2 className="flex items-center gap-1.5 pb-3 text-[10px] font-semibold uppercase tracking-wider z-muted">
        <Icon name="language" size={16} />
        {t("content.editor.translations.title")}
      </h2>

      <ul className="flex flex-col gap-1">
        {translations.map(({ locale, content }) => {
          const isCurrent = locale === currentLocale;

          // The language in its own name — the one a translator recognises.
          let name = locale;
          try {
            name = languageName.of(locale) ?? locale;
          } catch {
            /* An exotic tag Intl cannot name still shows as its code. */
          }

          return (
            <li key={locale}>
              {content ? (
                <TranslationRow
                  href={`/content/${type.key}/${content.id}`}
                  name={name}
                  locale={locale}
                  isCurrent={isCurrent}
                  title={content.title || t("content.editor.untitled")}
                  badge={
                    <Badge tone={STATUS_TONES[content.status]}>
                      {t(statusKey(content.status))}
                    </Badge>
                  }
                />
              ) : (
                <TranslationRow
                  href={`/content/${type.key}/new?translationOf=${sourceId}&locale=${locale}`}
                  name={name}
                  locale={locale}
                  isCurrent={false}
                  title={t("content.editor.translations.missing")}
                  muted
                  badge={
                    <span className="flex items-center gap-1 text-[11px] font-medium text-brand-600 dark:text-brand-300">
                      <Icon name="plus" size={14} />
                      {t("content.editor.translations.translate")}
                    </span>
                  }
                />
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function TranslationRow({
  href,
  name,
  locale,
  title,
  badge,
  isCurrent,
  muted = false,
}: {
  href: string;
  name: string;
  locale: string;
  title: string;
  badge: React.ReactNode;
  isCurrent: boolean;
  muted?: boolean;
}) {
  const className =
    "flex items-center gap-3 rounded-md px-2 py-2 text-xs transition-colors " +
    (isCurrent
      ? "bg-[var(--surface-sunken)] font-medium"
      : "hover:bg-[var(--surface-sunken)]");

  const body = (
    <>
      <Flag locale={locale} />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{name}</span>
        <span className={"block truncate text-[11px] z-muted" + (muted ? " italic" : "")}>
          {title}
        </span>
      </span>
      <span className="shrink-0">{badge}</span>
    </>
  );

  // The page you are already on is not a link. Making it one invites a navigation
  // that throws away whatever is unsaved in the form.
  if (isCurrent) return <div className={className}>{body}</div>;

  return (
    <Link href={href} className={className}>
      {body}
    </Link>
  );
}
