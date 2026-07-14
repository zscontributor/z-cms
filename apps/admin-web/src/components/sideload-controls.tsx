"use client";

import { useRef, useState, useTransition } from "react";
import {
  approveSideloadAction,
  sideloadAction,
  uninstallSideloadAction,
} from "@/app/actions/sideload";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n-provider";
import type { PackageKind } from "@/lib/api";

/**
 * Uploads a signed `.zcms` from the operator's machine.
 *
 * The file is verified against the operator key, scanned, and stored QUARANTINED on
 * the server — none of which happens here. This is only the file picker and the call.
 */
export function SideloadUpload({ kind }: { kind: PackageKind }) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        ref={inputRef}
        type="file"
        accept=".zcms"
        className="block max-w-[16rem] text-xs file:mr-2 file:rounded file:border-0 file:bg-brand-600 file:px-2 file:py-1 file:text-xs file:text-white"
        disabled={pending}
        onChange={() => setMessage(null)}
      />
      <Button
        size="sm"
        variant="primary"
        disabled={pending}
        onClick={() => {
          const file = inputRef.current?.files?.[0];
          if (!file) {
            setMessage({ ok: false, text: t("appearance.sideload.noFile") });
            return;
          }
          const formData = new FormData();
          formData.set("file", file, file.name);
          startTransition(async () => {
            const res = await sideloadAction(kind, formData);
            setMessage(
              res.ok ? { ok: true, text: res.message } : { ok: false, text: res.error },
            );
            if (res.ok && inputRef.current) inputRef.current.value = "";
          });
        }}
      >
        {pending ? t("appearance.sideload.uploading") : t("appearance.sideload.upload")}
      </Button>
      {message ? (
        <span
          className={
            message.ok
              ? "text-[11px] text-emerald-600 dark:text-emerald-400"
              : "text-[11px] text-red-600 dark:text-red-400"
          }
        >
          {message.text}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Approve (only while QUARANTINED) and Uninstall for one sideloaded package. Both
 * refuse anything that is not origin=SIDELOAD on the server, so these buttons can
 * never act on a built-in or marketplace package however they are rendered.
 */
export function SideloadActions({
  kind,
  itemKey,
  version,
  reviewStatus,
}: {
  kind: PackageKind;
  itemKey: string;
  version: string;
  reviewStatus: string;
}) {
  const t = useT();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null);
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) setError(res.error ?? t("appearance.sideload.actionFailed"));
    });
  };

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {reviewStatus !== "APPROVED" ? (
        <Button
          size="sm"
          variant="primary"
          disabled={pending}
          onClick={() => run(() => approveSideloadAction(kind, itemKey, version))}
        >
          {t("appearance.sideload.approve")}
        </Button>
      ) : null}
      <Button
        size="sm"
        variant="danger"
        disabled={pending}
        onClick={() => run(() => uninstallSideloadAction(kind, itemKey, version))}
      >
        {t("appearance.sideload.uninstall")}
      </Button>
      {error ? (
        <span className="text-[11px] text-red-600 dark:text-red-400">{error}</span>
      ) : null}
    </div>
  );
}
