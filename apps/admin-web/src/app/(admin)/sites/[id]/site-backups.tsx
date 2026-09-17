"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import type { SiteBackupDto } from "@zcmsorg/schemas";
import { createBackupAction, deleteBackupAction, listBackupsAction } from "@/app/actions/site";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useLocale, useT } from "@/lib/i18n-provider";
import { formatBytes, formatDateTime, type BadgeTone } from "@/lib/format";

/** While one of these is on the list, the screen asks again every few seconds. */
const POLL_MS = 4000;

const TONES: Record<SiteBackupDto["status"], BadgeTone> = {
  PENDING: "info",
  RUNNING: "warning",
  READY: "success",
  FAILED: "danger",
};

/** The browser-facing link for a part; the route handler adds the token. */
export function partHref(siteId: string, backupId: string, index: number): string {
  return `/api/sites/${encodeURIComponent(siteId)}/backups/${encodeURIComponent(backupId)}/parts/${index}`;
}

/** Whether a finished, downloadable backup exists — the delete dialog asks this. */
export function latestReady(backups: SiteBackupDto[]): SiteBackupDto | null {
  return backups.find((b) => b.status === "READY") ?? null;
}

/**
 * A site's backups: request one, watch it build, download its parts.
 *
 * The list is owned here rather than by the page because it changes on its own:
 * a backup is PENDING when requested and READY a minute later, with no action
 * from the person watching. While anything is in flight the component polls the
 * server action and stops the moment nothing is.
 *
 * A split archive is explained in place — which files, in what order, the one
 * command that joins them — because the person downloading it is a site owner,
 * not necessarily someone who has met a multi-part zip before.
 */
export function SiteBackups({
  siteId,
  initial,
  canManage,
  onChange,
}: {
  siteId: string;
  initial: SiteBackupDto[];
  canManage: boolean;
  /** Lets the delete dialog beside this know whether a READY backup exists. */
  onChange?: (backups: SiteBackupDto[]) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const [backups, setBackups] = useState<SiteBackupDto[]>(initial);
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);

  const replace = useCallback(
    (next: SiteBackupDto[]) => {
      setBackups(next);
      onChange?.(next);
    },
    [onChange],
  );

  const building = backups.some((b) => b.status === "PENDING" || b.status === "RUNNING");

  useEffect(() => {
    if (!building) return;
    const timer = setInterval(async () => {
      const res = await listBackupsAction(siteId);
      if (res.ok) replace(res.backups);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [building, siteId, replace]);

  const request = () => {
    setNotice(null);
    startTransition(async () => {
      const res = await createBackupAction(siteId);
      if (!res.ok) {
        setNotice({ ok: false, message: res.error });
        return;
      }
      setNotice({ ok: true, message: res.message });
      replace([res.backup, ...backups.filter((b) => b.id !== res.backup.id)]);
    });
  };

  const remove = (backupId: string) => {
    if (!window.confirm(t("admin.sites.backup.deleteConfirm"))) return;
    setNotice(null);
    startTransition(async () => {
      const res = await deleteBackupAction(siteId, backupId);
      if (!res.ok) {
        setNotice({ ok: false, message: res.error });
        return;
      }
      replace(backups.filter((b) => b.id !== backupId));
    });
  };

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold">{t("admin.sites.backup.title")}</h2>
        <p className="mt-0.5 text-[11px] leading-4 z-muted">{t("admin.sites.backup.help")}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={!canManage || pending || building}
          onClick={request}
        >
          {building ? t("admin.sites.backup.building") : t("admin.sites.backup.create")}
        </Button>
        {notice ? (
          <p
            role="status"
            className={
              notice.ok
                ? "text-sm text-emerald-600 dark:text-emerald-400"
                : "text-sm text-red-600 dark:text-red-400"
            }
          >
            {notice.message}
          </p>
        ) : null}
      </div>

      {backups.length === 0 ? (
        <p className="text-xs z-muted">{t("admin.sites.backup.empty")}</p>
      ) : (
        <ul className="space-y-3">
          {backups.map((backup) => (
            <li
              key={backup.id}
              className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-3 text-sm"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <Badge tone={TONES[backup.status]}>
                    {t(`admin.sites.backup.status.${backup.status}`)}
                  </Badge>
                  <span className="truncate font-mono text-xs">{backup.filename}</span>
                </div>
                <span className="text-xs z-muted">{formatDateTime(backup.createdAt, locale)}</span>
              </div>

              {backup.status === "FAILED" && backup.error ? (
                <p className="mt-2 text-xs text-red-600 dark:text-red-400">{backup.error}</p>
              ) : null}

              {backup.status === "READY" ? (
                <div className="mt-3 space-y-3">
                  <p className="text-xs z-muted">
                    {t("admin.sites.backup.summary", {
                      size: formatBytes(backup.totalBytes ?? 0),
                      parts: backup.parts.length,
                      contents: backup.summary?.counts.contents ?? 0,
                      media: backup.summary?.counts.media ?? 0,
                      expires: formatDateTime(backup.expiresAt, locale),
                    })}
                  </p>

                  <ol className="space-y-1">
                    {backup.parts.map((part) => (
                      <li key={part.index} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                        <a
                          href={partHref(siteId, backup.id, part.index)}
                          download={part.filename}
                          className="font-mono text-[var(--primary)] hover:underline"
                        >
                          {part.filename}
                        </a>
                        <span className="z-muted">{formatBytes(part.size)}</span>
                        <span className="z-muted font-mono" title={part.sha256}>
                          sha256 {part.sha256.slice(0, 12)}…
                        </span>
                      </li>
                    ))}
                  </ol>

                  {backup.parts.length > 1 ? (
                    <div className="rounded-md bg-[var(--surface-sunken)] p-3 text-xs">
                      <p className="font-medium">{t("admin.sites.backup.join.title")}</p>
                      <p className="mt-0.5 z-muted">{t("admin.sites.backup.join.help")}</p>
                      <pre className="mt-2 overflow-x-auto font-mono text-[11px] leading-5">
                        {`# macOS / Linux\ncat ${backup.filename}.* > ${backup.filename}\n\n# Windows (cmd)\ncopy /b ${backup.parts.map((p) => p.filename).join("+")} ${backup.filename}`}
                      </pre>
                      <p className="mt-2 z-muted">{t("admin.sites.backup.join.verify")}</p>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {backup.status === "READY" || backup.status === "FAILED" ? (
                <div className="mt-3">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={!canManage || pending}
                    onClick={() => remove(backup.id)}
                  >
                    {t("admin.sites.backup.delete")}
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
