"use client";

import { Icon } from "@/components/shell/icon";
import { useLocale } from "@/lib/i18n-provider";

/** The base locale every localized changelog carries, and the one others fall back to. */
const BASE_LOCALE = "en";

/**
 * The notes to show a reader in `locale`: their exact locale, then its region-less
 * base ("vi-VN" → "vi"), then English, then whatever the changelog does carry.
 *
 * This mirrors the server's `resolveChangelog` (@zcmsorg/package) deliberately —
 * admin-web does not depend on that package, so the few lines live here rather than
 * pulling a server-side bundle into the client. A plain string (a legacy changelog
 * the API still normalizes to `{ en }`) never reaches this, but is tolerated.
 */
function resolve(
  changelog: Record<string, string> | string | null | undefined,
  locale: string,
): string | null {
  if (!changelog) return null;
  if (typeof changelog === "string") return changelog.trim() || null;

  const base = locale.split("-")[0] ?? locale;
  const text =
    changelog[locale] ??
    changelog[base] ??
    changelog[BASE_LOCALE] ??
    Object.values(changelog)[0];
  return text?.trim() || null;
}

/**
 * A collapsible "What's new" note for a theme or plugin version.
 *
 * The release notes come straight from the package manifest's `changelog`, so the
 * author writes them once and every install of that version shows the same thing.
 * When the author translated them, the note is shown in the admin's own language,
 * falling back to English. Rendered `whitespace-pre-line` because a changelog is a
 * list: the newlines the author typed are the formatting. Nothing renders when there
 * are no notes — a theme that shipped none should not leave an empty disclosure behind.
 */
export function ChangelogNote({
  label,
  changelog,
}: {
  label: string;
  changelog: Record<string, string> | string | null | undefined;
}) {
  const locale = useLocale();
  const text = resolve(changelog, locale);
  if (!text) return null;

  return (
    <details className="group mt-3 rounded-md border border-[var(--border)] px-2.5 py-2">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px] font-semibold z-muted">
        <Icon
          name="chevron-right"
          size={14}
          className="shrink-0 transition-transform group-open:rotate-90"
        />
        {label}
      </summary>
      <p className="mt-2 whitespace-pre-line text-[11px] leading-4 z-muted">{text}</p>
    </details>
  );
}
