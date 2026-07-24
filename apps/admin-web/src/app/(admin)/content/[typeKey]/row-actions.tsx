"use client";

import { useState, useTransition } from "react";
import type { ContentDto } from "@zcmsorg/schemas";
import { deleteContentAction, publishContentAction } from "@/app/actions/content";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Icon } from "@/components/shell/icon";
import { useT } from "@/lib/i18n-provider";

export function RowActions({
  content,
  typeKey,
  canPublish,
  canDelete,
}: {
  content: ContentDto;
  typeKey: string;
  canPublish: boolean;
  canDelete: boolean;
}) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const isPublished = content.status === "PUBLISHED";

  function run(action: (formData: FormData) => Promise<void>, fields: Record<string, string>) {
    const formData = new FormData();
    for (const [key, value] of Object.entries(fields)) formData.set(key, value);
    setError(null);
    startTransition(async () => {
      try {
        await action(formData);
        setConfirming(false);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : t("common.actionFailed"));
      }
    });
  }

  const publishLabel = isPublished ? t("content.row.unpublish") : t("content.row.publish");

  return (
    <div className="flex items-center justify-end gap-1">
      {error ? (
        <span className="mr-1 text-[11px] text-red-600 dark:text-red-400">{error}</span>
      ) : null}

      {canPublish ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          title={publishLabel}
          onClick={() =>
            run(publishContentAction, {
              id: content.id,
              typeKey,
              publish: isPublished ? "false" : "true",
            })
          }
        >
          <Icon name={isPublished ? "eyeOff" : "eye"} size={18} />
          {publishLabel}
        </Button>
      ) : null}

      {canDelete ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          title={t("common.delete")}
          aria-label={t("content.row.deleteAria", { title: content.title })}
          onClick={() => setConfirming(true)}
          className="hover:text-red-600 dark:hover:text-red-400"
        >
          <Icon name="trash" size={18} />
        </Button>
      ) : null}

      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={t("content.delete.title")}
        description={t("content.delete.description", { title: content.title })}
        footer={
          <>
            <Button onClick={() => setConfirming(false)} disabled={pending}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={pending}
              className="bg-red-600 hover:bg-red-700 active:bg-red-800"
              onClick={() => run(deleteContentAction, { id: content.id, typeKey })}
            >
              {pending ? t("common.deleting") : t("common.delete")}
            </Button>
          </>
        }
      />
    </div>
  );
}
