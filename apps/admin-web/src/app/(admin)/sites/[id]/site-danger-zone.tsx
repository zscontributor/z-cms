"use client";

import { useState } from "react";
import type { SiteBackupDto, SiteDto } from "@zcmsorg/schemas";
import { DeleteSiteDialog } from "./delete-site-dialog";
import { SiteBackups, latestReady } from "./site-backups";

/**
 * Backups and deletion, side by side — and sharing one fact: whether a finished
 * backup exists. The backups panel owns the list (it polls while one builds);
 * the delete dialog only needs to know the newest READY one, so it can say
 * "you have a backup from 14:32" or "you have none" at the moment it matters.
 */
export function SiteDangerZone({
  site,
  initialBackups,
  canManage,
  canDelete,
}: {
  site: SiteDto;
  initialBackups: SiteBackupDto[];
  canManage: boolean;
  canDelete: boolean;
}) {
  const [ready, setReady] = useState<SiteBackupDto | null>(latestReady(initialBackups));

  return (
    <div className="z-card space-y-6 p-5">
      <SiteBackups
        siteId={site.id}
        initial={initialBackups}
        canManage={canManage}
        onChange={(backups) => setReady(latestReady(backups))}
      />
      <div className="border-t border-[var(--border)] pt-5">
        <DeleteSiteDialog site={site} canDelete={canDelete} latestReady={ready} />
      </div>
    </div>
  );
}
