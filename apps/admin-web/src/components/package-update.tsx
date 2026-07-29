"use client";

import { useState, useTransition } from "react";
import { installFromMarketplaceAction } from "@/app/actions/marketplace";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/shell/icon";
import type { PackageKind } from "@/lib/api";
import { useT } from "@/lib/i18n-provider";

/**
 * "Update available" surfaced where a package is actually managed — Appearance and
 * Plugins — not only on the marketplace screen. With many themes and plugins
 * installed, an admin should not have to visit the marketplace to learn that one
 * of them has moved on.
 *
 * The freshness check and the Update action are the same as the marketplace's own
 * (`installFromMarketplaceAction` → verified download → advance active installs),
 * so the screens can never disagree about what an "update" is. Like the
 * marketplace, the check is a raw string inequality: it flags "different", not
 * strictly "newer".
 */
export function hasUpdate(
  installed: string | null | undefined,
  latest: string | null | undefined,
): boolean {
  return installed != null && latest != null && installed !== latest;
}

/** A small warning badge naming the version the marketplace has moved to. */
export function UpdateBadge({ latestVersion }: { latestVersion: string }) {
  const t = useT();
  return (
    <Badge tone="warning">
      {t("admin.marketplace.browse.updateBadge", { version: latestVersion })}
    </Badge>
  );
}

/**
 * The Update action for an installed theme/plugin. Renders the button, and on
 * success collapses to a confirmation; on failure surfaces the error inline. The
 * page revalidates on success (the server action does), so the version shown next
 * to the package refreshes on its own.
 */
export function UpdateButton({
  kind,
  itemKey,
  latestVersion,
}: {
  kind: PackageKind;
  itemKey: string;
  latestVersion: string;
}) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function update() {
    setError(null);
    startTransition(async () => {
      const result = await installFromMarketplaceAction(kind, itemKey, latestVersion);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice(result.message);
    });
  }

  if (notice) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
        <Icon name="check" className="h-3.5 w-3.5" />
        {notice}
      </span>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Button size="sm" variant="primary" onClick={update} disabled={pending}>
        <Icon name="install" className="mr-1 h-3.5 w-3.5" />
        {pending ? t("admin.marketplace.browse.installing") : t("admin.marketplace.browse.update")}
      </Button>
      {error ? (
        <p
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-2.5 py-2 text-[11px] text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
