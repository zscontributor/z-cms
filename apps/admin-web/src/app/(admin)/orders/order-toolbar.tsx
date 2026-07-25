"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ORDER_STATUSES } from "@zcmsorg/schemas";
import { Input, Select } from "@/components/ui/field";
import { orderStatusKey } from "@/lib/format";
import { useT } from "@/lib/i18n-provider";

/** Filters live in the URL, so a filtered order list is linkable and survives a save. */
export function OrderToolbar() {
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

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <form onSubmit={onSearch}>
        <Input
          type="search"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder={t("commerce.list.searchPlaceholder")}
          aria-label={t("commerce.list.searchLabel")}
          className="h-8 w-64 py-1 text-xs"
        />
      </form>

      <Select
        aria-label={t("commerce.list.statusFilter")}
        value={params.get("status") ?? ""}
        onChange={(event) => onStatus(event.target.value)}
        className="h-8 w-44 py-1 text-xs"
      >
        <option value="">{t("commerce.list.allStatuses")}</option>
        {ORDER_STATUSES.map((status) => (
          <option key={status} value={status}>
            {t(orderStatusKey(status))}
          </option>
        ))}
      </Select>
    </div>
  );
}
