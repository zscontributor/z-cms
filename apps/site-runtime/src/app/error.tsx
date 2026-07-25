"use client";

import { PlatformError } from "@/components/platform-error";

/**
 * The site's 5xx page.
 *
 * Next renders this — with a real 500 status on the initial request — whenever a
 * Server Component in this segment throws: cms-api unreachable (RenderApiError),
 * an upstream 5xx, or a theme template that failed while rendering. It runs inside
 * the root layout, so `<html lang>` and the colour-mode attributes are already
 * set; it only supplies the body.
 *
 * The 404 (app/not-found.tsx) is drawn in the site's own theme because it resolves
 * server-side; a 5xx cannot — an error boundary is a Client Component, and the
 * failure it is catching may BE the theme. So the platform draws its own page. See
 * components/platform-error.tsx for why it depends on nothing that could be down.
 */

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <PlatformError error={error} reset={reset} />;
}
