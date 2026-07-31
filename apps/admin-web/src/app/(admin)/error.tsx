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

  /**
   * The tab is older than the server.
   *
   * A Server Action is addressed by an id baked into the page at BUILD time, so a
   * tab left open across a deploy asks the new build to run an action it has never
   * heard of. Next's own message ("Server Action … was not found on the server")
   * is accurate and reads like a fault in the software; it is neither, and it is
   * NOT retryable — `reset()` re-runs the same dead id from the same stale
   * JavaScript. Only a fresh page has ids this server knows.
   *
   * The other half of it, and the reason this says "may already have happened":
   * the action often DID run. The uninstall this was first seen on completed on
   * the server and failed only on the way back, which is exactly the state where
   * "Retry" is the most damaging button on the screen.
   */
  const stale = /server action .*(was not found|not found on the server)/i.test(error.message);

  const title = expired
    ? t("auth.session.expiredTitle")
    : stale
      ? t("admin.error.staleTitle")
      : t("admin.error.title");
  const hint = expired
    ? t("auth.session.expiredHint")
    : stale
      ? t("admin.error.staleHint")
      : error.message;

  return (
    <div className="z-card mx-auto max-w-md p-8 text-center">
      <h1 className="text-sm font-semibold">{title}</h1>
      <p className="mt-1 text-xs z-muted">{hint}</p>
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
        ) : stale ? (
          // A full load, not `reset()`: the fix is new JavaScript, and `reset()`
          // keeps the old.
          <Button variant="primary" onClick={() => window.location.reload()}>
            {t("admin.error.reload")}
          </Button>
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
