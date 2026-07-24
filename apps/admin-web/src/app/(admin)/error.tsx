"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n-provider";

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useT();

  useEffect(() => {
    console.error(error);
  }, [error]);

  // The API client throws UnauthenticatedError when the refresh token is gone
  // too; middleware will bounce the next navigation, so offer the login link.
  const expired = error.message === t("auth.session.expired") || /401/.test(error.message);

  return (
    <div className="z-card mx-auto max-w-md p-8 text-center">
      <h1 className="text-sm font-semibold">
        {expired ? t("auth.session.expiredTitle") : t("admin.error.title")}
      </h1>
      <p className="mt-1 text-xs z-muted">
        {expired ? t("auth.session.expiredHint") : error.message}
      </p>
      {error.digest ? (
        <p className="mt-2 font-mono text-[10px] z-muted">#{error.digest}</p>
      ) : null}

      <div className="mt-5 flex justify-center gap-2">
        {expired ? (
          <Link
            href="/login"
            className="inline-flex h-9 items-center rounded-md bg-brand-500 px-3.5 text-sm font-medium text-white hover:bg-brand-600"
          >
            {t("auth.session.signInAgain")}
          </Link>
        ) : (
          <Button variant="primary" onClick={reset}>
            {t("common.retry")}
          </Button>
        )}
        <Link
          href="/"
          className="inline-flex h-9 items-center rounded-md border border-[var(--border-strong)] px-3.5 text-sm font-medium hover:bg-[var(--surface-sunken)]"
        >
          {t("admin.backToDashboard")}
        </Link>
      </div>
    </div>
  );
}
