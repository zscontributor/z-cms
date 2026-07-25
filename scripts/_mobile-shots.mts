/**
 * Ad-hoc responsive screenshotter for the z-soft theme.
 * Renders the theme's own bundle at several viewport widths so we can SEE
 * where the layout breaks (mobile especially). Reuses the same context-building
 * approach as scripts/theme-screenshots.mts.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  COLOR_MODE_ATTRIBUTE,
  COLOR_MODE_ICON_ATTRIBUTE,
  resolveColorModes,
  resolveThemeSettings,
} from "@zcmsorg/theme-sdk";
import type { Theme, ThemeContext, ThemeManifest } from "@zcmsorg/theme-sdk";

const REPO = "/Users/z-soft/Data/z-soft/z-cms";
const OUT = process.env.OUT_DIR!;
const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

type AnyTheme = Theme<Record<string, unknown>>;

const dir = path.join(REPO, "themes", "z-soft");
const mod = (await import(pathToFileURL(path.join(dir, "dist/index.mjs")).href)) as { default: AnyTheme };
const theme: AnyTheme = mod.default ?? (mod as unknown as AnyTheme);
const css = fs.readFileSync(path.join(dir, "dist/theme.css"), "utf8");
const manifest = theme.manifest as ThemeManifest & {
  demo?: { settings?: Record<string, unknown>; menus?: any[]; contents?: any[]; contentTypes?: any[] };
  collections?: Record<string, any>;
};

function flatten(input: Record<string, unknown>, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) Object.assign(out, flatten(value as any, full));
    else if (typeof value === "string") out[full] = value;
  }
  return out;
}

function toContent(demo: any, path_: string, index = 0) {
  const day = String(14 - Math.min(index, 13)).padStart(2, "0");
  const published = `2026-05-${day}T09:00:00.000Z`;
  return {
    id: `demo-${demo.contentType}-${demo.slug || "home"}`,
    siteId: "shot",
    contentType: { id: demo.contentType, key: demo.contentType, name: demo.contentType },
    locale: demo.locale, translationGroupId: "demo", title: demo.title, slug: demo.slug,
    path: path_, excerpt: demo.excerpt ?? null, data: demo.data ?? {}, blocks: demo.blocks ?? [],
    seo: {}, status: "PUBLISHED", publishedAt: published,
    author: { id: "a", name: "Z-SOFT" }, createdAt: published, updatedAt: published,
  };
}

function prefixFor(contentType: string): string {
  const p = manifest.demo?.contentTypes?.find((c: any) => c.key === contentType)?.routePrefix;
  return p ? `${p}/` : "";
}

function resolveCollections(locale: string): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  const demo = manifest.demo?.contents ?? [];
  for (const [name, query] of Object.entries(manifest.collections ?? {})) {
    const q = query as any;
    out[name] = demo
      .filter((c: any) => c.contentType === q.contentType && c.locale === locale)
      .slice(0, q.limit ?? 12)
      .map((c: any, i: number) => toContent(c, c.slug ? `/${prefixFor(c.contentType)}${c.slug}` : "/", i));
  }
  return out;
}

function buildContext(locale: string): ThemeContext<Record<string, unknown>> {
  const settings = { ...resolveThemeSettings<Record<string, unknown>>(manifest.settingsSchema, null), ...(manifest.demo?.settings ?? {}) };
  const menus: Record<string, unknown> = {};
  for (const menu of manifest.demo?.menus ?? []) {
    menus[menu.key] = { key: menu.key, name: menu.name, items: menu.items.map((it: any, i: number) => ({ id: `${menu.key}-${i}`, label: it.label, url: it.url, target: it.target ?? "", children: [] })) };
  }
  const catalog = (theme as any).messages ?? {};
  const flat = flatten((catalog[locale] ?? catalog.en ?? {}));
  const base = flatten((catalog.en ?? {}));
  const ctx: any = {
    site: { id: "shot", name: String(settings.siteTitle ?? manifest.name), canonicalHost: "example.com", locale, defaultLocale: "en", locales: ["en", "ja", "vi"], brand: { primaryColor: String(settings.primaryColor ?? "#FA5600"), logo: "" } },
    settings, menus, locale,
    t: (key: string, vars?: Record<string, string | number>) => (flat[key] ?? base[key] ?? key).replace(/\{(\w+)\}/g, (_m, n) => (vars && n in vars ? String(vars[n]) : `{${n}}`)),
    renderBlocks: (blocks: unknown[]): ReactNode => (blocks ?? []).map((raw: any, i: number) => { const C = theme.blocks?.[raw.type]; return C ? createElement(C as never, { key: raw.id ?? i, block: raw, props: raw.props ?? {}, ctx } as never) : null; }),
    hasCapability: () => false, getIntegration: () => undefined, renderSlot: () => null,
    collections: resolveCollections(locale),
    colorMode: resolveColorModes(manifest, settings),
    url: (p: string) => (locale === "en" ? p || "/" : `/${locale}${p === "/" ? "" : p}`),
    asset: (p: string) => (/^([a-z]+:)?\/\//i.test(p) || p.startsWith("/") ? p : pathToFileURL(path.join(dir, p)).href),
    alternates: ["en", "ja", "vi"].map((code) => ({ locale: code, path: code === "en" ? "/" : `/${code}`, current: code === locale, flagUrl: null })),
  };
  return ctx as ThemeContext<Record<string, unknown>>;
}

function document_(html: string, mode: "light" | "dark"): string {
  const icons = `[${COLOR_MODE_ICON_ATTRIBUTE}="dark"]{display:none}html[${COLOR_MODE_ATTRIBUTE}="dark"] [${COLOR_MODE_ICON_ATTRIBUTE}="dark"]{display:revert}html[${COLOR_MODE_ATTRIBUTE}="dark"] [${COLOR_MODE_ICON_ATTRIBUTE}="light"]{display:none}`;
  // A thin red frame appears via ::after ONLY when the body overflows horizontally,
  // making sideways-scroll (the classic mobile break) visible in a static shot.
  const overflowProbe = `html,body{overflow-x:hidden}`;
  return `<!doctype html><html lang="en" ${COLOR_MODE_ATTRIBUTE}="${mode}" style="color-scheme:${mode}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*,::before,::after{box-sizing:border-box}body{margin:0}${icons}${css}</style></head><body>${html}</body></html>`;
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function shoot(htmlPath: string, outPath: string, w: number, h: number) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcms-shot-"));
  fs.rmSync(outPath, { force: true });
  const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--hide-scrollbars", "--force-color-profile=srgb", "--allow-file-access-from-files", "--virtual-time-budget=4000", "--run-all-compositor-stages-before-draw", `--user-data-dir=${userDataDir}`, `--window-size=${w},${h}`, `--screenshot=${outPath}`, pathToFileURL(htmlPath).href], { stdio: "ignore" });
  try {
    let prev = -1;
    for (let i = 0; i < 120; i++) { await sleep(400); const size = fs.existsSync(outPath) ? fs.statSync(outPath).size : -1; if (size > 0 && size === prev) return; prev = size; }
    throw new Error(`no screenshot ${outPath}`);
  } finally { chrome.kill("SIGKILL"); fs.rmSync(userDataDir, { recursive: true, force: true }); }
}

const contents = manifest.demo?.contents ?? [];
const en = contents.filter((c: any) => c.locale === "en");
const home = en.find((c: any) => c.slug === "");
const services = en.find((c: any) => c.slug === "services") ?? en.find((c: any) => c.slug && c.slug !== "");
const product = en.find((c: any) => c.contentType === "product");

const pages = [
  { name: "home", content: home, kind: "home" },
  { name: "services", content: services, kind: "page" },
  { name: "product", content: product, kind: "page" },
].filter((p) => p.content);

const widths = [
  { w: 360, h: 3400, tag: "360" },
  { w: 390, h: 3400, tag: "390" },
  { w: 768, h: 3000, tag: "768" },
  { w: 1024, h: 2600, tag: "1024" },
];

fs.mkdirSync(OUT, { recursive: true });
for (const page of pages) {
  for (const vw of widths) {
    const ctx = buildContext("en");
    const Template = page.kind === "home" ? (theme.templates.home ?? theme.templates.page) : theme.templates.page;
    const content = toContent(page.content, page.content.slug ? `/${page.content.slug}` : "/");
    const markup = renderToStaticMarkup(createElement(theme.Layout as never, { ctx } as never, createElement(Template as never, { ctx, content } as never)));
    const tmpHtml = path.join(os.tmpdir(), `zs-${page.name}-${vw.tag}.html`);
    fs.writeFileSync(tmpHtml, document_(markup, "light"));
    const out = path.join(OUT, `${page.name}-${vw.tag}.png`);
    await shoot(tmpHtml, out, vw.w, vw.h);
    console.log(`shot ${page.name} @ ${vw.tag}`);
    fs.rmSync(tmpHtml, { force: true });
  }
}
console.log("done");
