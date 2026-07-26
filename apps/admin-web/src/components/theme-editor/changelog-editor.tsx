"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveThemeDraftAction } from "@/app/actions/theme-draft";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/field";
import { useT } from "@/lib/i18n-provider";

/**
 * The per-version, per-locale release notes editor.
 *
 * This is the "What's new" box, the one field of a theme an author TYPES rather than
 * draws. It saves onto the draft, and the build feeds it into the signed theme.json —
 * so the notes ride inside the package the marketplace verifies, not beside it.
 *
 * English is the base and is required the moment any other language is written: it is
 * the fallback every reader whose language is missing will see. Saving goes through
 * the ordinary draft PATCH, which re-stages the build — the panel says so, because a
 * signature must cover the notes it ships with.
 */

const BASE_LOCALE = "en";
/** Same shape the server accepts: "en", "vi", "pt-BR", "zh-Hans". */
const LOCALE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

type Extra = { locale: string; text: string };

function toExtras(changelog: Record<string, string> | null): Extra[] {
  if (!changelog) return [];
  return Object.entries(changelog)
    .filter(([locale]) => locale !== BASE_LOCALE)
    .map(([locale, text]) => ({ locale, text }));
}

export function ChangelogEditor({
  draftId,
  changelog,
}: {
  draftId: string;
  changelog: Record<string, string> | null;
}) {
  const t = useT();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [en, setEn] = useState(changelog?.en ?? "");
  const [extras, setExtras] = useState<Extra[]>(() => toExtras(changelog));
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // What is on the server right now, serialized the same way a save would build it,
  // so Save can stay disabled until something actually changed — a no-op save would
  // still re-stage the build, which is a needless step to force on an author.
  const savedSnapshot = useMemo(() => JSON.stringify(changelog ?? null), [changelog]);

  function build(): { changelog: Record<string, string> | null } | { error: string } {
    const map: Record<string, string> = {};
    const trimmedEn = en.trim();
    if (trimmedEn) map[BASE_LOCALE] = trimmedEn;

    for (const { locale, text } of extras) {
      const notes = text.trim();
      if (!notes) continue; // a blank row is nothing to save, not an error
      const code = locale.trim();
      if (!LOCALE_RE.test(code)) {
        return { error: t("themeEditor.changelog.invalidLocale", { locale: code || "?" }) };
      }
      map[code] = notes;
    }

    const hasOthers = Object.keys(map).some((l) => l !== BASE_LOCALE);
    if (!trimmedEn && hasOthers) {
      return { error: t("themeEditor.changelog.englishRequired") };
    }
    // Nothing anywhere clears the notes; a lone English entry is the normal case.
    return { changelog: Object.keys(map).length ? map : null };
  }

  const nextSnapshot = (() => {
    const result = build();
    return "error" in result ? null : JSON.stringify(result.changelog);
  })();
  const dirty = nextSnapshot !== null && nextSnapshot !== savedSnapshot;

  function save() {
    setError(null);
    setMessage(null);
    const result = build();
    if ("error" in result) {
      setError(result.error);
      return;
    }
    start(async () => {
      const saved = await saveThemeDraftAction(draftId, { changelog: result.changelog });
      if (!saved.ok) {
        setError(saved.error || t("themeEditor.changelog.saveFailed"));
        return;
      }
      setMessage(t("themeEditor.changelog.saved"));
      // The save reset the staged build server-side; refresh so the Publish panel
      // asks for a new build instead of offering to sign the old one.
      router.refresh();
    });
  }

  return (
    <section className="space-y-3 border-t border-neutral-200 p-4 dark:border-neutral-800">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
        {t("themeEditor.changelog.heading")}
      </h3>
      <p className="text-[11px] leading-4 z-muted">{t("themeEditor.changelog.hint")}</p>

      {error ? <p className="text-xs text-red-600">{error}</p> : null}
      {message ? <p className="text-xs text-green-600">{message}</p> : null}

      <Field label={t("themeEditor.changelog.englishLabel")} required>
        <Textarea
          rows={3}
          value={en}
          disabled={pending}
          placeholder={t("themeEditor.changelog.englishPlaceholder")}
          onChange={(e) => setEn(e.target.value)}
        />
      </Field>

      {extras.map((row, i) => (
        <div key={i} className="space-y-1.5 rounded-md border border-[var(--border)] p-2.5">
          <div className="flex items-center gap-2">
            <Input
              className="w-28 font-mono text-[11px]"
              value={row.locale}
              disabled={pending}
              placeholder={t("themeEditor.changelog.localeCodePlaceholder")}
              aria-label={t("themeEditor.changelog.localeCodeLabel")}
              onChange={(e) =>
                setExtras((rows) =>
                  rows.map((r, j) => (j === i ? { ...r, locale: e.target.value } : r)),
                )
              }
            />
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => setExtras((rows) => rows.filter((_, j) => j !== i))}
            >
              {t("themeEditor.changelog.remove")}
            </Button>
          </div>
          <Textarea
            rows={3}
            value={row.text}
            disabled={pending}
            placeholder={t("themeEditor.changelog.notesPlaceholder")}
            onChange={(e) =>
              setExtras((rows) => rows.map((r, j) => (j === i ? { ...r, text: e.target.value } : r)))
            }
          />
        </div>
      ))}

      <div className="flex flex-wrap gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => setExtras((rows) => [...rows, { locale: "", text: "" }])}
        >
          {t("themeEditor.changelog.addLanguage")}
        </Button>
        <Button size="sm" disabled={pending || !dirty} onClick={save}>
          {pending ? t("themeEditor.actions.saving") : t("themeEditor.changelog.save")}
        </Button>
      </div>
    </section>
  );
}
