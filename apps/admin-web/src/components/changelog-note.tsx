import { Icon } from "@/components/shell/icon";

/**
 * A collapsible "What's new" note for a theme or plugin version.
 *
 * The release notes come straight from the package manifest's `changelog`, so the
 * author writes them once and every install of that version shows the same thing.
 * Rendered `whitespace-pre-line` because a changelog is a list: the newlines the
 * author typed are the formatting. Nothing renders when there are no notes — a theme
 * that shipped none should not leave an empty disclosure behind.
 */
export function ChangelogNote({
  label,
  changelog,
}: {
  label: string;
  changelog: string | null | undefined;
}) {
  const text = changelog?.trim();
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
