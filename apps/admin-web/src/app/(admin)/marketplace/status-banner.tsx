import type { MarketplaceStatusDto } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { getT } from "@/lib/locale";

/**
 * How fresh this instance's kill-switch feed is — stated plainly, at the top.
 *
 * Revocation sync is fail-open: when the marketplace is unreachable the instance
 * keeps running what it has. That is the right call (a marketplace outage must
 * not dark a thousand sites), but it has a cost, and the cost is that "nothing to
 * revoke" and "I have not been able to ask in six weeks" look identical from the
 * inside. This banner is where they stop looking identical. The usual fail-open
 * design makes the same choice and shows the user nothing.
 *
 * When everything is current the banner is a single quiet line — reassurance, not
 * an alarm. It goes amber only when the feed is stale or the last sync errored,
 * because a warning that is always on is a warning nobody reads.
 */
export async function StatusBanner({
  status,
  locale,
}: {
  status: MarketplaceStatusDto;
  locale: string;
}) {
  const t = await getT();

  // No marketplace configured: this instance is its own. There is no remote feed
  // to be stale, so there is nothing to warn about.
  if (!status.url) {
    return (
      <p className="mb-4 text-xs z-muted">
        {t("admin.marketplace.sync.local")}
      </p>
    );
  }

  const synced = status.lastSyncedAt
    ? formatDateTime(status.lastSyncedAt, locale)
    : t("admin.marketplace.sync.never");

  if (status.stale) {
    return (
      <div
        role="alert"
        className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200"
      >
        <p className="font-semibold">{t("admin.marketplace.sync.staleTitle")}</p>
        <p className="mt-1 text-[13px] leading-5">
          {t("admin.marketplace.sync.staleBody", { url: status.url, synced })}
        </p>
        {status.lastError ? (
          <p className="mt-1.5 font-mono text-[11px] opacity-80">{status.lastError}</p>
        ) : null}
      </div>
    );
  }

  return (
    <p className="mb-4 text-xs z-muted">
      {t("admin.marketplace.sync.fresh", {
        url: status.url,
        synced,
        count: status.revokedCount,
      })}
    </p>
  );
}
