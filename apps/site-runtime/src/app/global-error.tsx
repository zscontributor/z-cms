"use client";

import { PlatformError } from "@/components/platform-error";

/**
 * The floor beneath everything.
 *
 * `error.tsx` catches errors thrown by the page; it cannot catch an error thrown
 * by the root layout itself, because it renders *inside* that layout. This does —
 * it REPLACES the root layout, which is why it has to supply its own <html> and
 * <body>. Reached only when the document shell failed, so it assumes nothing about
 * lang or colour mode: `prefers-color-scheme` in PlatformError's own CSS is the
 * fallback that still gives a dark-on-dark reader a dark page here.
 */

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body>
        <PlatformError error={error} reset={reset} />
      </body>
    </html>
  );
}
