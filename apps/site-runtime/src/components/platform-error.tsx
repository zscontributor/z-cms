"use client";

import { useEffect, useState } from "react";

/**
 * The platform's own error page — z-cms's default, not any theme's.
 *
 * This is what a visitor sees on a 5xx: cms-api unreachable, an upstream 500, or a
 * theme template that threw while rendering. Unlike the 404 (app/not-found.tsx),
 * which resolves the site's theme server-side and draws the theme's own `notFound`
 * template, a 5xx surfaces through Next's error boundary — a Client Component that
 * cannot do the async, server-only theme resolution the 404 does. So the failure
 * that would most often BE a broken theme is drawn by the runtime instead, in a
 * self-contained page that depends on nothing that could already be down: no
 * cms-api call, no theme CSS, no globals.css (app/global-error.tsx replaces the
 * root layout entirely and gets none of it). Everything it needs — colours, dark
 * mode, copy — is inlined below.
 *
 * A theme is still free to own the 404 completely; the 5xx is the platform's floor.
 */

/**
 * The handful of strings this page needs, for the locales z-cms's own UI ships.
 *
 * These are NOT read from `@zcmsorg/i18n`'s catalogue the way the server-rendered
 * 404 reads `site.notFound.*`: that catalogue is a server module, and this is a
 * client boundary that must render with zero network and zero server-resolved
 * props. Four strings in three languages is a cheaper, more robust price than
 * shipping (or fetching) the catalogue into a page whose whole job is to work when
 * other things have failed. Base locale (en) is the fallback for anything else.
 */
const COPY = {
  en: {
    title: "Something went wrong",
    description:
      "An unexpected error occurred while loading this page. Please try again in a moment.",
    tryAgain: "Try again",
    backHome: "Back to home",
  },
  vi: {
    title: "Đã xảy ra lỗi",
    description:
      "Một lỗi không mong muốn đã xảy ra khi tải trang này. Vui lòng thử lại sau giây lát.",
    tryAgain: "Thử lại",
    backHome: "Về trang chủ",
  },
  ja: {
    title: "問題が発生しました",
    description:
      "このページの読み込み中に予期しないエラーが発生しました。しばらくしてからもう一度お試しください。",
    tryAgain: "再試行",
    backHome: "ホームに戻る",
  },
} as const;

type CopyLocale = keyof typeof COPY;

function isCopyLocale(value: string): value is CopyLocale {
  return value in COPY;
}

export interface PlatformErrorProps {
  /** The boundary's error. Its `digest` is the only thread to the server logs. */
  error?: (Error & { digest?: string }) | undefined;
  /** Next's boundary reset — re-attempts rendering the failed segment. */
  reset?: (() => void) | undefined;
}

export function PlatformError({ error, reset }: PlatformErrorProps) {
  // Server render (and the first client render, to match it) uses the base locale;
  // the real one is read from <html lang> — set by the root layout from the locale
  // cms-api resolved — only after mount, so the two never disagree at hydration.
  const [locale, setLocale] = useState<CopyLocale>("en");

  useEffect(() => {
    const lang = document.documentElement.lang?.split("-")[0] ?? "";
    if (isCopyLocale(lang)) setLocale(lang);
  }, []);

  // The digest is the only handle an operator has between what the visitor saw and
  // the line in the logs. Surface it in the console (not the page) so support can
  // read it back without it becoming visible noise on the page itself.
  useEffect(() => {
    if (error?.digest) console.error(`[site-runtime] Render error digest: ${error.digest}`);
  }, [error?.digest]);

  const t = COPY[locale];

  return (
    <div className="zerr">
      {/* Self-contained: this page must render when globals.css does not exist
          (global-error replaces the root layout) and when the active theme's CSS
          was never loaded. Scoped under `.zerr` so it collides with nothing. */}
      <style
        dangerouslySetInnerHTML={{
          __html: `
.zerr {
  --zerr-bg: #ffffff;
  --zerr-fg: #0a0a0a;
  --zerr-muted: #52525b;
  --zerr-border: #e4e4e7;
  --zerr-brand: #FA5600;
  --zerr-brand-fg: #ffffff;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.5rem;
  background: var(--zerr-bg);
  color: var(--zerr-fg);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
}
@media (prefers-color-scheme: dark) {
  .zerr {
    --zerr-bg: #0a0a0a;
    --zerr-fg: #fafafa;
    --zerr-muted: #a1a1aa;
    --zerr-border: #27272a;
  }
}
:root[data-theme="light"] .zerr {
  --zerr-bg: #ffffff; --zerr-fg: #0a0a0a; --zerr-muted: #52525b; --zerr-border: #e4e4e7;
}
:root[data-theme="dark"] .zerr {
  --zerr-bg: #0a0a0a; --zerr-fg: #fafafa; --zerr-muted: #a1a1aa; --zerr-border: #27272a;
}
.zerr__inner { width: 100%; max-width: 32rem; text-align: center; }
.zerr__code {
  font-size: 0.75rem; font-weight: 700; letter-spacing: 0.15em;
  text-transform: uppercase; color: var(--zerr-brand); margin: 0 0 0.75rem;
}
.zerr__title { font-size: 1.75rem; font-weight: 800; line-height: 1.15; margin: 0 0 0.75rem; }
.zerr__desc { font-size: 1rem; line-height: 1.6; color: var(--zerr-muted); margin: 0 0 1.75rem; }
.zerr__actions { display: flex; gap: 0.75rem; justify-content: center; flex-wrap: wrap; }
.zerr__btn {
  display: inline-flex; align-items: center; justify-content: center;
  height: 2.75rem; padding: 0 1.25rem; border-radius: 0.625rem;
  font-size: 0.9375rem; font-weight: 600; cursor: pointer; text-decoration: none;
  border: 1px solid transparent; transition: opacity .15s ease, background-color .15s ease;
}
.zerr__btn--primary { background: var(--zerr-brand); color: var(--zerr-brand-fg); }
.zerr__btn--primary:hover { opacity: 0.9; }
.zerr__btn--ghost { background: transparent; color: var(--zerr-fg); border-color: var(--zerr-border); }
.zerr__btn--ghost:hover { background: var(--zerr-border); }
`,
        }}
      />
      <div className="zerr__inner">
        <p className="zerr__code">500</p>
        <h1 className="zerr__title">{t.title}</h1>
        <p className="zerr__desc">{t.description}</p>
        <div className="zerr__actions">
          {reset ? (
            <button type="button" className="zerr__btn zerr__btn--primary" onClick={() => reset()}>
              {t.tryAgain}
            </button>
          ) : null}
          <a className="zerr__btn zerr__btn--ghost" href="/">
            {t.backHome}
          </a>
        </div>
      </div>
    </div>
  );
}
