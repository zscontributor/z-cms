import { headers } from "next/headers";
import type { ReactNode } from "react";
import { colorModeIconCss, colorModeScript } from "@/lib/color-mode";
import { contactEnhanceScript } from "@/lib/contact-enhance";
import { formPickScript } from "@/lib/form-pick";
import { revealOnTargetScript } from "@/lib/reveal-on-target";
import { sliderScript } from "@/lib/slider";
import { queryScript } from "@/lib/plugin-query";
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
        {/* The browser blanks a script's `nonce` attribute after applying the CSP
            (a spec anti-exfiltration measure), so the DOM the client hydrates
            reads nonce="" while the server sent the real one. `suppressHydration-
            Warning` on <html> does not reach these nested scripts, so each one
            has to opt out itself — otherwise this benign, unavoidable mismatch
            drowns out real hydration warnings (and bails out the subtree). */}
        <script
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: colorModeScript(colorMode) }}
        />
        {/* Keyed off the SDK's attributes, not any theme's classes, so every
            theme's toggle swaps its icon without shipping CSS for it. */}
        <style dangerouslySetInnerHTML={{ __html: colorModeIconCss }} />
      </head>
      <body>
        {children}
        {/* Runs after the DOM is parsed: reveals any `data-reveal-on-target`
            element the URL fragment points at, working around Blink not
            activating `:target` after an HTTP redirect. A generic platform
            primitive for no-JS themes (see lib/reveal-on-target.ts), not tied to
            any one feature. Nonce'd like the color-mode script above. */}
        <script
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: revealOnTargetScript() }}
        />
        {/* Progressive enhancement for the contact form: stricter email
            validation, and submit-over-fetch so a failed send keeps what the
            visitor typed (only a real success clears the form). Falls back to the
            plain POST + redirect above when this does not run. */}
        <script
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: contactEnhanceScript() }}
        />
        {/* Enhances every `data-zw-slider` (drawn-theme sliders): autoplay,
            active-dot sync, pause-on-hover, arrows relative to the current slide.
            The slider swipes and its anchors scroll with no JS; this only adds what
            CSS cannot. Bounded to marked elements, honours reduced-motion. */}
        <script
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: sliderScript() }}
        />
        {/* Enhances every `data-zc-query` filter form: fetch the plugin's `query`
            capability over `/plugin-query/*` and render the returned rows into the
            theme's row <template>, as text. A no-JS theme shows whatever it rendered
            on the server; this adds the live, filtered list on top. Bounded to marked
            forms, values written as text, hrefs refused unless http(s)/relative. */}
        <script
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: queryScript() }}
        />
        {/* Enhances every `data-zc-pick` Add control: keeps a per-form basket in
            localStorage, counts it into the theme's `data-zc-pick-count` badge and
            tells the form island to fill its item slots. With no JS the control is
            still the anchor to the form it always was. */}
        <script
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: formPickScript() }}
        />
      </body>
    </html>
  );
}
