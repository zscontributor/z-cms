"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Input, Select } from "@/components/ui/field";
import { Icon } from "@/components/shell/icon";
import { useT } from "@/lib/i18n-provider";

/**
 * Search and the type filter live in the URL, like every other list in the
 * admin: a filtered library has to be linkable and has to survive the round trip
 * through an upload or a delete.
 *
 * Searching drops `folder` on purpose. A search that only looked inside the open
 * folder would answer "nothing found" about a file the user can see two folders
 * away, which is the exact moment they reached for the search box.
 */
export function LibraryToolbar() {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const [term, setTerm] = useState(params.get("q") ?? "");

  useEffect(() => {
    setTerm(params.get("q") ?? "");
  }, [params]);

  function push(next: URLSearchParams) {
    next.delete("page");
    const query = next.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  function onSearch(event: React.FormEvent) {
    event.preventDefault();
    const next = new URLSearchParams(params.toString());
    if (term.trim()) {
      next.set("q", term.trim());
      next.delete("folder");
    } else {
      next.delete("q");
    }
    push(next);
  }

  function onKind(value: string) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set("kind", value);
    else next.delete("kind");
    push(next);
  }

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <form onSubmit={onSearch} className="relative">
        <Input
          type="search"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder={t("media.list.searchPlaceholder")}
          aria-label={t("media.list.searchLabel")}
          className="h-8 w-64 py-1 pl-8 text-xs"
        />
        <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 opacity-50">
          <Icon name="search" size={14} />
        </span>
      </form>

      <Select
        aria-label={t("media.list.kindFilter")}
        value={params.get("kind") ?? ""}
        onChange={(event) => onKind(event.target.value)}
        className="h-8 w-40 py-1 text-xs"
      >
        <option value="">{t("media.list.allKinds")}</option>
        <option value="image">{t("media.list.images")}</option>
        <option value="document">{t("media.list.documents")}</option>
      </Select>
    </div>
  );
}
