import Link from "next/link";
import { cn } from "@/lib/cn";
import { getT } from "@/lib/locale";

/** Server-rendered pagination: every page is a real, linkable URL. */
export async function Pagination({
  page,
  totalPages,
  total,
  basePath,
  query,
}: {
  page: number;
  totalPages: number;
  total: number;
  basePath: string;
  query: Record<string, string | undefined>;
}) {
  const t = await getT();

  if (totalPages <= 1) {
    return <p className="mt-3 text-[11px] z-muted">{t("common.pagination.results", { total })}</p>;
  }

  const href = (target: number) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value) params.set(key, value);
    }
    if (target > 1) params.set("page", String(target));
    const search = params.toString();
    return search ? `${basePath}?${search}` : basePath;
  };

  const windowStart = Math.max(1, Math.min(page - 2, totalPages - 4));
  const windowEnd = Math.min(totalPages, windowStart + 4);
  const pages: number[] = [];
  for (let index = windowStart; index <= windowEnd; index += 1) pages.push(index);

  const linkClass = (active: boolean) =>
    cn(
      "inline-flex h-7 min-w-7 items-center justify-center rounded-md border px-2 text-xs transition-colors",
      active
        ? "border-brand-500 bg-brand-500 text-white"
        : "border-[var(--border-strong)] hover:bg-[var(--surface-sunken)]",
    );

  return (
    <nav
      className="mt-3 flex items-center justify-between gap-3"
      aria-label={t("common.pagination.label")}
    >
      <p className="text-[11px] z-muted">
        {t("common.pagination.summary", { page, totalPages, total })}
      </p>
      <div className="flex items-center gap-1">
        {page > 1 ? (
          <Link href={href(page - 1)} className={linkClass(false)}>
            {t("common.pagination.previous")}
          </Link>
        ) : null}
        {pages.map((target) => (
          <Link key={target} href={href(target)} className={linkClass(target === page)}>
            {target}
          </Link>
        ))}
        {page < totalPages ? (
          <Link href={href(page + 1)} className={linkClass(false)}>
            {t("common.pagination.next")}
          </Link>
        ) : null}
      </div>
    </nav>
  );
}
