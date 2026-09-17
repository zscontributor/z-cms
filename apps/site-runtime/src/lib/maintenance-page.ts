import type { LocalizedText, SiteClosureMode, SiteMaintenanceStateDto } from "@zcmsorg/schemas";

/**
 * The maintenance notice, as a complete HTML document.
 *
 * Built as a string rather than rendered through React: it is served from
 * middleware, before any page or theme is resolved, and it must work when the
 * theme is exactly what is being repaired. So it depends on nothing — no theme
 * CSS, no globals.css, no script, no font — and inlines the little it needs, like
 * `platform-error.tsx` does for the 5xx. Everything the owner chose (title, text,
 * logo, background, colours) arrives through `SiteMaintenanceStateDto`, already
 * validated on the way in; it is escaped again here anyway, because this string
 * IS the document and a stray quote in a URL would be markup.
 */

/**
 * The platform's own wording, for a site whose owner wrote none — in the
 * languages the platform ships. Kept here rather than read from `@zcmsorg/i18n`:
 * that catalogue is for the server, and pulling it into the middleware bundle
 * for three strings is the wrong trade.
 */
interface Copy {
  title: string;
  message: string;
  /** Label before the date: "Expected back" / "Launching". */
  when: string;
  /** Countdown unit labels, coming soon only. */
  units: [string, string, string, string];
}

const COPY: Record<SiteClosureMode, Record<string, Copy>> = {
  maintenance: {
    en: {
      title: "We'll be back soon",
      message: "This site is undergoing scheduled maintenance. Please check back shortly.",
      when: "Expected back",
      units: ["days", "hours", "minutes", "seconds"],
    },
    vi: {
      title: "Chúng tôi sẽ quay lại sớm",
      message: "Website đang được bảo trì. Vui lòng quay lại sau ít phút.",
      when: "Dự kiến hoạt động lại",
      units: ["ngày", "giờ", "phút", "giây"],
    },
    ja: {
      title: "まもなく再開します",
      message: "現在メンテナンス中です。しばらくしてから再度アクセスしてください。",
      when: "再開予定",
      units: ["日", "時間", "分", "秒"],
    },
  },
  "coming-soon": {
    en: {
      title: "Coming soon",
      message: "Something new is on its way. Stay tuned.",
      when: "Launching",
      units: ["days", "hours", "minutes", "seconds"],
    },
    vi: {
      title: "Sắp ra mắt",
      message: "Điều mới mẻ đang được chuẩn bị. Hãy quay lại sớm nhé.",
      when: "Ra mắt",
      units: ["ngày", "giờ", "phút", "giây"],
    },
    ja: {
      title: "近日公開",
      message: "新しいサイトを準備中です。どうぞお楽しみに。",
      when: "公開予定",
      units: ["日", "時間", "分", "秒"],
    },
  },
};

/**
 * One language out of the owner's text — the same fallback order as
 * `resolveLocalizedText` in @zcmsorg/schemas, re-stated here so this module
 * imports only TYPES from the schemas package: a value import would pull zod
 * into the middleware bundle for the sake of six lines.
 */
export function pickText(text: LocalizedText | undefined, locale: string, defaultLocale: string): string {
  if (!text) return "";
  const base = locale.split("-")[0] ?? locale;
  const candidates = [text[locale], text[base], text[defaultLocale], ...Object.values(text)];
  return candidates.find((value) => typeof value === "string" && value.trim() !== "")?.trim() ?? "";
}

function copyFor(mode: SiteClosureMode, locale: string): Copy {
  const table = COPY[mode];
  return table[locale] ?? table[locale.split("-")[0] ?? ""] ?? table.en!;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * A URL fit for `src` and for CSS `url()`: http(s) or site-relative, and none of
 * the characters that could close either context. Anything else becomes "" —
 * the page then simply has no image, rather than an injection point.
 */
export function safeUrl(value: string): string {
  const trimmed = value.trim();
  if (!/^(https?:\/\/|\/)/i.test(trimmed)) return "";
  if (/[\s"'()<>\\]/.test(trimmed)) return "";
  return trimmed;
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** `#RRGGBB` → `rgba(r, g, b, a)`; a value that is not a colour falls back. */
export function hexToRgba(hex: string, alpha: number, fallback = "#0F172A"): string {
  const source = HEX_RE.test(hex) ? hex : fallback;
  const r = Number.parseInt(source.slice(1, 3), 16);
  const g = Number.parseInt(source.slice(3, 5), 16);
  const b = Number.parseInt(source.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function safeHex(value: string, fallback: string): string {
  return HEX_RE.test(value) ? value : fallback;
}

/** Plain text with line breaks → one `<p>` per non-empty line, escaped. */
function paragraphs(text: string, className: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p class="${className}">${escapeHtml(line)}</p>`)
    .join("");
}

function formatWhen(iso: string, locale: string): string | null {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  try {
    // Explicit components, not dateStyle/timeStyle: those two refuse to be
    // combined with `timeZoneName`, and the zone is the part that keeps "09:00"
    // honest for a reader who is not where the server is.
    return new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(at);
  } catch {
    return new Date(at).toUTCString();
  }
}

/**
 * The countdown, for a coming-soon page with a launch date. Progressive: the
 * server prints the remaining days/hours/minutes/seconds, and this script keeps
 * them ticking. Carries the request's CSP nonce, without which it would not run.
 * Once the date passes the numbers stop at zero — the owner opens the site.
 */
function countdownScript(nonce: string): string {
  return `<script nonce="${escapeHtml(nonce)}">(function(){var el=document.querySelector("[data-zm-launch]");if(!el)return;var at=Date.parse(el.getAttribute("data-zm-launch"));if(isNaN(at))return;var cells=el.querySelectorAll("[data-zm-unit]");function pad(n){return n<10?"0"+n:String(n)}function tick(){var left=Math.max(0,Math.floor((at-Date.now())/1000));var v=[Math.floor(left/86400),Math.floor(left%86400/3600),Math.floor(left%3600/60),left%60];for(var i=0;i<cells.length;i++){cells[i].textContent=i===0?String(v[i]):pad(v[i])}}tick();setInterval(tick,1000)})();</script>`;
}

function countdownParts(at: number, now: number): [number, number, number, number] {
  const left = Math.max(0, Math.floor((at - now) / 1000));
  return [
    Math.floor(left / 86400),
    Math.floor((left % 86400) / 3600),
    Math.floor((left % 3600) / 60),
    left % 60,
  ];
}

export function renderMaintenanceHtml(
  state: SiteMaintenanceStateDto,
  locale: string,
  options: { nonce?: string; now?: number } = {},
): string {
  const mode: SiteClosureMode = state.mode === "coming-soon" ? "coming-soon" : "maintenance";
  const copy = copyFor(mode, locale);
  const { site } = state;

  const title = pickText(state.title, locale, site.defaultLocale) || copy.title;
  const message = pickText(state.message, locale, site.defaultLocale) || copy.message;
  // The owner's logo for this page, else the site's brand logo — the same one the
  // theme draws, so a site that never set a maintenance logo is still recognisable.
  const logo = safeUrl(state.logo) || safeUrl(site.brand.logo);
  const background = safeUrl(state.backgroundImage);
  const bg = safeHex(state.backgroundColor, "#0F172A");
  const fg = safeHex(state.textColor, "#FFFFFF");
  const accent = safeHex(site.brand.primaryColor, "#FA5600");
  const when = state.expectedBackAt ? formatWhen(state.expectedBackAt, locale) : null;
  // A coming-soon page with a launch date counts down to it; a maintenance page
  // just names the time. Nobody wants to watch an outage tick.
  const launchAt = mode === "coming-soon" && when ? Date.parse(state.expectedBackAt!) : NaN;
  const countdown = Number.isNaN(launchAt)
    ? ""
    : (() => {
        const parts = countdownParts(launchAt, options.now ?? Date.now());
        const cells = parts
          .map(
            (value, i) =>
              `<div class="zm__cell"><span class="zm__num" data-zm-unit>${i === 0 ? value : String(value).padStart(2, "0")}</span><span class="zm__unit">${escapeHtml(copy.units[i]!)}</span></div>`,
          )
          .join("");
        return `<div class="zm__countdown" data-zm-launch="${escapeHtml(state.expectedBackAt!)}" role="timer" aria-live="off">${cells}</div>`;
      })();

  // With an image, the chosen colour becomes a tint over it so the text stays
  // readable on any photo; without one it is simply the page.
  const backdrop = background
    ? `background-image: linear-gradient(${hexToRgba(bg, 0.72)}, ${hexToRgba(bg, 0.72)}), url(${background});`
    : "";

  const documentTitle = `${title} · ${site.name}`;

  return `<!doctype html>
<html lang="${escapeHtml(locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${mode === "maintenance" ? '<meta name="robots" content="noindex, nofollow">\n' : ""}<title>${escapeHtml(documentTitle)}</title>
<style>
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; }
.zm {
  --zm-bg: ${bg};
  --zm-fg: ${fg};
  --zm-accent: ${accent};
  min-height: 100vh;
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem 1rem;
  background-color: var(--zm-bg);
  background-position: center;
  background-size: cover;
  background-repeat: no-repeat;
  color: var(--zm-fg);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  text-align: center;
}
.zm__inner { width: 100%; max-width: 36rem; }
.zm__logo { display: block; margin: 0 auto 2rem; max-height: 4.5rem; max-width: 14rem; object-fit: contain; }
.zm__bar { width: 3rem; height: 0.25rem; border-radius: 999px; background: var(--zm-accent); margin: 0 auto 1.5rem; }
.zm__title { font-size: clamp(1.75rem, 4vw, 2.5rem); font-weight: 800; line-height: 1.15; letter-spacing: -0.01em; margin: 0 0 1rem; }
.zm__text { font-size: 1.0625rem; line-height: 1.65; margin: 0 0 0.75rem; opacity: 0.88; }
.zm__eta { margin: 1.75rem 0 0; font-size: 0.875rem; opacity: 0.75; }
.zm__eta time { font-weight: 600; opacity: 1; }
.zm__site { margin: 2.5rem 0 0; font-size: 0.75rem; letter-spacing: 0.12em; text-transform: uppercase; opacity: 0.55; }
.zm__countdown { display: flex; justify-content: center; gap: 0.75rem; margin: 2rem 0 0; font-variant-numeric: tabular-nums; }
.zm__cell { min-width: 4.25rem; padding: 0.75rem 0.5rem; border-radius: 0.75rem; background: rgba(127, 127, 127, 0.18); border: 1px solid rgba(127, 127, 127, 0.25); }
.zm__num { display: block; font-size: 1.75rem; font-weight: 800; line-height: 1; }
.zm__unit { display: block; margin-top: 0.35rem; font-size: 0.6875rem; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.7; }
@media (prefers-reduced-motion: no-preference) {
  .zm__inner { animation: zm-in 480ms ease-out both; }
  @keyframes zm-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
}
</style>
</head>
<body>
<main class="zm" style="${backdrop}">
  <div class="zm__inner">
    ${logo ? `<img class="zm__logo" src="${escapeHtml(logo)}" alt="${escapeHtml(site.name)}">` : `<div class="zm__bar" aria-hidden="true"></div>`}
    <h1 class="zm__title">${escapeHtml(title)}</h1>
    ${paragraphs(message, "zm__text")}
    ${countdown}
    ${
      when && state.expectedBackAt
        ? `<p class="zm__eta">${escapeHtml(copy.when)}: <time datetime="${escapeHtml(state.expectedBackAt)}">${escapeHtml(when)}</time></p>`
        : ""
    }
    ${logo ? `<p class="zm__site">${escapeHtml(site.name)}</p>` : ""}
  </div>
</main>
${countdown && options.nonce ? countdownScript(options.nonce) : ""}
</body>
</html>
`;
}
