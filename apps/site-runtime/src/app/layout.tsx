import { headers } from "next/headers";
import type { ReactNode } from "react";
import { colorModeIconCss, colorModeScript } from "@/lib/color-mode";
import { resolveDocumentColorMode } from "@/lib/color-mode-server";
import { resolveDocumentLocale } from "@/lib/render-client";
import "./globals.css";

/**
 * The document shell — and nothing more.
 *
 * Everything visible (header, footer, colours) belongs to the active theme, which
 * is only known after `render/resolve` answers for this hostname.
 *
 * `lang` and `dir` are the exception, because they belong to <html> and nothing
 * further down can set them. They come from the locale the URL resolved to —
 * "/vi/blog" is Vietnamese — which only cms-api can decide. This does not cost a
 * second API call: `resolveDocumentLocale` goes through the same React-cached
 * `resolveRender` the page does, with the same arguments, so the two share one
 * result. The render contract is still one call per page.
 *
 * `dir` matters more than it looks: an Arabic or Hebrew site rendered `ltr` is not
 * "slightly off", it is unusable.
 *
 * `data-theme` — dark or light — is the third attribute that belongs to <html>,
 * and it is the one the server cannot decide: only the browser knows what this
 * visitor chose last time, or what their OS prefers. See lib/color-mode.ts for why
 * the runtime owns the mechanism and the theme owns only the appearance.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  // Both resolve through the same React-cached render call, so this shell still
  // costs the page nothing.
  const [{ lang, dir }, colorMode] = await Promise.all([
    resolveDocumentLocale(),
    resolveDocumentColorMode(),
  ]);

  // The per-request CSP nonce minted in middleware.ts. An inline script without it
  // does not run — which is the whole point of the nonce, and why this one has to
  // ask for it rather than being trusted for living in the layout.
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    // The script below sets `data-theme` on this element before the body parses,
    // so the server's markup and the client's first paint differ by construction.
    // That is the design, not a hydration bug — hence the suppression.
    <html lang={lang} dir={dir} suppressHydrationWarning>
      <head>
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{ __html: colorModeScript(colorMode) }}
        />
        {/* Keyed off the SDK's attributes, not any theme's classes, so every
            theme's toggle swaps its icon without shipping CSS for it. */}
        <style dangerouslySetInnerHTML={{ __html: colorModeIconCss }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
