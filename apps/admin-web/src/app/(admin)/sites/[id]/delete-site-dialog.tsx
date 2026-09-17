"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { SiteBackupDto, SiteDto } from "@zcmsorg/schemas";
import { deleteSiteAction } from "@/app/actions/site";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/field";
import { useLocale, useT } from "@/lib/i18n-provider";
import { formatDateTime } from "@/lib/format";

/**
 * The one irreversible control on the site screen.
 *
 * Three things stand between the button and the deletion, and each is there
 * for a different failure: the list of what goes, for the person who thought
 * "delete site" meant "unpublish"; the backup line, for the person who meant it
 * but has not taken a copy — it says whether a downloadable backup exists and
 * when it was made, and the checkbox makes them say they have it (or do not
 * want it); and the slug, typed, for the person with the wrong site open.
 *
 * `latestReady` is whatever the backups panel currently shows, so a backup
 * that finished while this dialog was closed is known here when it opens.
 */
export function DeleteSiteDialog({
  site,
  canDelete,
  latestReady,
}: {
  site: SiteDto;
  canDelete: boolean;
  latestReady: SiteBackupDto | null;
}) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const matches = typed.trim().toLowerCase() === site.slug.toLowerCase();

  const close = () => {
    if (pending) return;
    setOpen(false);
    setTyped("");
    setAcknowledged(false);
    setError(null);
  };

  const confirm = () => {
    setError(null);
    startTransition(async () => {
      const res = await deleteSiteAction(site.id, typed.trim());
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // The site is gone; so is this page. The list is the only sensible place
      // to land, and a refresh makes the sidebar's switcher forget the site too.
      router.push("/sites");
      router.refresh();
    });
  };

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-red-600 dark:text-red-400">
          {t("admin.sites.delete.title")}
        </h2>
        <p className="mt-0.5 text-[11px] leading-4 z-muted">{t("admin.sites.delete.help")}</p>
      </div>
      <Button
        type="button"
        variant="danger"
        size="sm"
        disabled={!canDelete}
        onClick={() => setOpen(true)}
      >
        {t("admin.sites.delete.button")}
      </Button>

      <Dialog
        open={open}
        onClose={close}
        title={t("admin.sites.delete.dialogTitle", { name: site.name })}
        description={t("admin.sites.delete.dialogDescription")}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={close} disabled={pending}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={pending || !matches || !acknowledged}
              onClick={confirm}
            >
              {pending ? t("admin.sites.delete.deleting") : t("admin.sites.delete.confirm")}
            </Button>
          </>
        }
      >
        <div className="space-y-4 text-sm">
          <div className="rounded-md border border-red-300 bg-red-50 p-3 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
            <p className="font-medium">{t("admin.sites.delete.whatGoesTitle")}</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
              {(["content", "media", "menus", "themes", "orders", "members", "backups"] as const).map(
                (item) => (
                  <li key={item}>{t(`admin.sites.delete.whatGoes.${item}`)}</li>
                ),
              )}
            </ul>
          </div>

          <div className="rounded-md bg-[var(--surface-sunken)] p-3 text-xs">
            {latestReady ? (
              <p>
                {t("admin.sites.delete.backupReady", {
                  when: formatDateTime(latestReady.finishedAt ?? latestReady.createdAt, locale),
                  file: latestReady.filename,
                })}
              </p>
            ) : (
              <p className="text-amber-700 dark:text-amber-300">
                {t("admin.sites.delete.backupMissing")}
              </p>
            )}
          </div>

          <label className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            <span>{t("admin.sites.delete.acknowledge")}</span>
          </label>

          <div>
            <Label htmlFor="delete-site-slug">
              {t("admin.sites.delete.typeSlug", { slug: site.slug })}
            </Label>
            <Input
              id="delete-site-slug"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder={site.slug}
              className="font-mono"
            />
          </div>

          {error ? (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          ) : null}
        </div>
      </Dialog>
    </section>
  );
}
