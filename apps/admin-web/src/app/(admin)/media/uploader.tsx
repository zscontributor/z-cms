"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { uploadMediaAction } from "@/app/actions/media";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/shell/icon";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n-provider";

/**
 * `folderId` is the folder currently being browsed. Files land where the user is
 * looking — dropping a file into an open folder and finding it at the root would
 * be a small betrayal, and it is the whole reason folders exist.
 */
export function Uploader({ folderId }: { folderId?: string | null }) {
  const t = useT();
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);

  function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    const list = Array.from(files);
    setError(null);

    startTransition(async () => {
      for (const [index, file] of list.entries()) {
        setProgress(
          t("media.uploader.progress", {
            index: index + 1,
            total: list.length,
            name: file.name,
          }),
        );
        const formData = new FormData();
        formData.set("file", file);
        if (folderId) formData.set("folderId", folderId);
        const result = await uploadMediaAction(formData);
        if (!result.ok) {
          setError(`${file.name}: ${result.error}`);
          break;
        }
      }
      setProgress(null);
      if (inputRef.current) inputRef.current.value = "";
      router.refresh();
    });
  }

  return (
    <div className="mb-4">
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          upload(event.dataTransfer.files);
        }}
        className={cn(
          "flex flex-col items-center justify-center gap-2 rounded-md border border-dashed px-6 py-8 text-center transition-colors",
          dragging
            ? "border-brand-500 bg-brand-50 dark:bg-brand-500/10"
            : "border-[var(--border-strong)] bg-[var(--surface-raised)]",
        )}
      >
        <Icon name="upload" size={20} className="z-muted" />
        <p className="text-xs z-muted">{t("media.uploader.hint")}</p>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => upload(event.target.files)}
        />
        <Button
          variant="primary"
          size="sm"
          disabled={pending}
          onClick={() => inputRef.current?.click()}
        >
          {pending ? t("media.uploader.uploading") : t("media.uploader.choose")}
        </Button>
        {progress ? <p className="text-[11px] z-muted">{progress}</p> : null}
        {error ? (
          <p role="alert" className="text-[11px] text-red-600 dark:text-red-400">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
