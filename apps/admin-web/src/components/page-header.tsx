import Link from "next/link";
import type { ReactNode } from "react";

export function PageHeader({
  title,
  description,
  actions,
  back,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  /**
   * Where this screen came from, rendered above the title like a breadcrumb.
   *
   * It sits on the left rather than in `actions`: "back" is where you are, not
   * something you do to the record, and putting it in the top-right corner made it
   * compete with the screen's real actions — the corner a reader reaches for to
   * edit or delete.
   */
  back?: { href: string; label: string };
}) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        {back ? (
          <Link href={back.href} className="text-xs z-muted hover:underline">
            ← {back.label}
          </Link>
        ) : null}
        <h1 className={`text-xl font-semibold tracking-tight${back ? " mt-1" : ""}`}>{title}</h1>
        {description ? <p className="mt-0.5 text-xs z-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
