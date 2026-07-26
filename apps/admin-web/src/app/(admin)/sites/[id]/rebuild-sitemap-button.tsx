"use client";

import { useState, useTransition } from "react";
import { rebuildSitemapAction } from "@/app/actions/site";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n-provider";

/**
 * Queues a rebuild of this site's sitemap.xml, on demand.
 *
 * Its own action, not part of the site form's Save: regenerating the sitemap does
 * not change any site field, so folding it into the PATCH would be a lie about what
 * the button does. Disabled while pending so a human cannot pile up rebuilds, and
 * gated on the same `canUpdate` the page already computed — the API enforces
 * `site:update` regardless, this just keeps a read-only viewer from a pointless 403.
 */
export function RebuildSitemapButton({
  siteId,
  canUpdate,
}: {
  siteId: string;
  canUpdate: boolean;
}) {
  const t = useT();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={!canUpdate || pending}
        onClick={() => {
          setResult(null);
          startTransition(async () => {
            const res = await rebuildSitemapAction(siteId);
            setResult(
              res.ok
                ? { ok: true, message: res.message }
                : { ok: false, message: res.error },
            );
          });
        }}
      >
        {pending ? t("admin.sites.sitemap.generating") : t("admin.sites.sitemap.generate")}
      </Button>

      {result ? (
        <p
          role="status"
          className={
            result.ok
              ? "text-sm text-emerald-600 dark:text-emerald-400"
              : "text-sm text-red-600 dark:text-red-400"
          }
        >
          {result.message}
        </p>
      ) : null}
    </div>
  );
}
