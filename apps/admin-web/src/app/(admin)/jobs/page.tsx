import type { Metadata } from "next";
import { can, getSession, listFailedJobs, type FailedJobPageDto } from "@/lib/api";
import { getLocale, getT } from "@/lib/locale";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/ui/table";
import { JobsTable } from "./jobs-table";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("admin.jobs.metaTitle") };
}

export const dynamic = "force-dynamic";

/**
 * The dead-letter queue.
 *
 * Everything here is work that was supposed to happen and did not: an email that
 * was never sent, a cache that was never purged. It is a short list on a healthy
 * instance, which is why the empty state is written to reassure rather than to
 * apologise for having nothing to show.
 */
export default async function JobsPage() {
  const t = await getT();
  const locale = await getLocale();
  const user = await getSession();

  if (!can(user, "settings:update")) {
    return <div className="z-card p-10 text-center text-sm">{t("admin.jobs.denied")}</div>;
  }

  const LIMIT = 50;
  const page = await safe<FailedJobPageDto>(() => listFailedJobs(LIMIT), {
    items: [],
    total: 0,
  });

  // The queue can be longer than the page. Saying so is the difference between
  // "you have handled the failures" and "you have handled the ones you could see".
  const truncated = page.total > page.items.length;

  return (
    <>
      <PageHeader title={t("admin.jobs.title")} description={t("admin.jobs.description")} />

      {page.items.length === 0 ? (
        <div className="z-card">
          <EmptyState
            title={t("admin.jobs.emptyTitle")}
            description={t("admin.jobs.emptyDescription")}
          />
        </div>
      ) : (
        <>
          {truncated ? (
            <p className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
              {t("admin.jobs.truncated", {
                shown: String(page.items.length),
                total: String(page.total),
              })}
            </p>
          ) : null}
          <JobsTable jobs={page.items} locale={locale} />
        </>
      )}
    </>
  );
}

/** An unreachable API must not take the screen down with it. */
async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}
