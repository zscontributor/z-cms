"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ContentStatusSchema } from "@zcmsorg/schemas";
import { Input, Select } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import { statusKey } from "@/lib/format";
import { useT } from "@/lib/i18n-provider";

/** Derived from the schema so a new status cannot be forgotten here. */
const CONTENT_STATUSES = ContentStatusSchema.options;

/**
 * Filters live in the URL, not in component state: a filtered list has to be
 * linkable and has to survive the round trip through a publish action.
 */
export function ListToolbar({
  typeKey,
  locales,
  selectedLocale,
}: {
  typeKey: string;
  locales: string[];
  selectedLocale: string;
}) {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const [term, setTerm] = useState(params.get("q") ?? "");

  // Reset the box when the route changes under us (site switch, type switch).
  useEffect(() => {
    setTerm(params.get("q") ?? "");
  }, [params, typeKey]);

  function push(next: URLSearchParams) {
    // Any filter change invalidates the current page number.
    next.delete("page");
    const query = next.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  function onSearch(event: React.FormEvent) {
    event.preventDefault();
    const next = new URLSearchParams(params.toString());
    if (term.trim()) next.set("q", term.trim());
    else next.delete("q");
    push(next);
  }

  function onStatus(value: string) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set("status", value);
    else next.delete("status");
    push(next);
  }

  function hrefForLocale(value: string) {
    const next = new URLSearchParams(params.toString());
    next.set("locale", value);
    next.delete("page");
    const query = next.toString();
    return query ? `${pathname}?${query}` : pathname;
  }

  const languageNames = new Intl.DisplayNames([selectedLocale], { type: "language" });

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      {locales.length > 1 ? (
        <div
          className="flex h-8 items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--surface-sunken)] p-1"
          role="tablist"
          aria-label={t("content.list.languageTabs")}
        >
          {locales.map((value) => {
            const active = value === selectedLocale;
            return (
              <a
                key={value}
                href={hrefForLocale(value)}
                role="tab"
                aria-selected={active}
                className={cn(
                  "inline-flex h-6 items-center rounded px-2 text-xs font-medium transition-colors",
                  active
                    ? "bg-[var(--surface-raised)] text-[var(--foreground)] shadow-sm"
                    : "z-muted hover:text-[var(--foreground)]",
                )}
              >
                {languageNames.of(value) ?? value}
              </a>
            );
          })}
        </div>
      ) : null}

      <form onSubmit={onSearch} className="relative">
        <Input
          type="search"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder={t("content.list.searchPlaceholder")}
          aria-label={t("content.list.searchLabel")}
          className="h-8 w-64 py-1 pl-8 text-xs"
        />
        <svg
          className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 opacity-50"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden
        >
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.3-4.3" strokeLinecap="round" />
        </svg>
      </form>

      <Select
        aria-label={t("content.list.statusFilter")}
        value={params.get("status") ?? ""}
        onChange={(event) => onStatus(event.target.value)}
        className="h-8 w-40 py-1 text-xs"
      >
        <option value="">{t("content.list.allStatuses")}</option>
        {CONTENT_STATUSES.map((status) => (
          <option key={status} value={status}>
            {t(statusKey(status))}
          </option>
        ))}
      </Select>
    </div>
  );
}
