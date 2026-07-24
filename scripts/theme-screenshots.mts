/**
 * Marketplace screenshots, taken of the real thing.
 *
 *   pnpm tsx scripts/theme-screenshots.mts default market magazine
 *
 * A screenshot is the only thing most people will look at before installing a
 * theme, so it has to be a photograph and not a painting. Rather than drawing
 * marketing art that merely resembles the theme, this script loads the theme's own
 * compiled bundle, renders its own templates with its own stylesheet, and points a
 * real browser at the result. If the theme is ugly or broken, the screenshot is
 * ugly or broken — which is exactly the property you want from a screenshot.
 *
 * How it works:
 *
 *   1. import the built bundle (themes/<t>/dist/index.mjs — run `pnpm build` first)
 *   2. build a ThemeContext by hand, filled from the theme's OWN manifest: settings
 *      from the schema defaults + `demo.settings`, menus from `demo.menus`, content
 *      from `demo.contents`. Nothing here invents content — a theme that ships a
 *      good demo gets a good screenshot, which is the right incentive.
 *   3. renderToStaticMarkup, wrapped in a document that inlines the theme's CSS and
 *      sets `data-theme` on <html> exactly as site-runtime's colour-mode script does
 *   4. headless Chrome takes the picture, sharp normalises it
 *
 * Which shots are taken is not this script's decision either: it takes one per
 * entry in the manifest's `media.screenshots`, and names the file what the manifest
 * says. The order is fixed by convention — home (light), home (dark), then a
 * single-item page (a post, or a product where the theme has one).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import sharp from "sharp";
import { clampCollectionLimit } from "@zcmsorg/schemas";
import {
  COLOR_MODE_ATTRIBUTE,
  COLOR_MODE_ICON_ATTRIBUTE,
  resolveColorModes,
  resolveThemeSettings,
} from "@zcmsorg/theme-sdk";
import type { Theme, ThemeContext, ThemeManifest } from "@zcmsorg/theme-sdk";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Wide enough for the desktop layout; tall enough to show more than the hero. */
const VIEWPORT = { width: 1600, height: 1200 };

const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// ---------------------------------------------------------------- theme loading

interface DemoContent {
  contentType: string;
  locale: string;
  slug: string;
  title: string;
  excerpt?: string;
  data?: Record<string, unknown>;
  blocks?: unknown[];
}

interface DemoMenu {
  key: string;
  name: string;
  items: { label: string; url: string; target?: string }[];
}

type AnyTheme = Theme<Record<string, unknown>>;

async function loadTheme(dir: string): Promise<{ theme: AnyTheme; css: string }> {
  const entry = path.join(dir, "dist/index.mjs");
  const styles = path.join(dir, "dist/theme.css");

  if (!fs.existsSync(entry) || !fs.existsSync(styles)) {
    throw new Error(
      `${path.relative(REPO, entry)} is missing. Build the theme first: ` +
        `pnpm --filter ./${path.relative(REPO, dir)} build`,
    );
  }

  const mod = (await import(pathToFileURL(entry).href)) as { default: AnyTheme };
  return { theme: mod.default ?? (mod as unknown as AnyTheme), css: fs.readFileSync(styles, "utf8") };
}

// ------------------------------------------------------------------ the context

/**
 * A ThemeContext good enough to render with.
 *
 * `asset` is the interesting one: on a real site it resolves to a URL served out of
 * the theme's verified bundle, but Chrome here is looking at a file:// document, so
 * a theme's shipped logo has to resolve to a file:// path or it silently renders as
 * a broken image in the shot. An already-absolute path is passed through, exactly as
 * the real implementation does.
 */
function buildContext(
  theme: AnyTheme,
  themeDir: string,
  locale: string,
): ThemeContext<Record<string, unknown>> {
  const manifest = theme.manifest as ThemeManifest & {
    demo?: { settings?: Record<string, unknown>; menus?: DemoMenu[] };
  };

  const settings = {
    ...resolveThemeSettings<Record<string, unknown>>(manifest.settingsSchema, null),
    ...(manifest.demo?.settings ?? {}),
  };

  const menus: Record<string, unknown> = {};
  for (const menu of manifest.demo?.menus ?? []) {
    menus[menu.key] = {
      key: menu.key,
      name: menu.name,
      items: menu.items.map((item, index) => ({
        id: `${menu.key}-${index}`,
        label: item.label,
        url: item.url,
        target: item.target ?? "",
        children: [],
      })),
    };
  }

  const catalog = theme.messages ?? {};
  const flat = flatten((catalog[locale] ?? catalog.en ?? {}) as Record<string, unknown>);
  const base = flatten((catalog.en ?? {}) as Record<string, unknown>);

  const ctx = {
    site: {
      id: "screenshot",
      name: String(settings.siteTitle ?? manifest.name),
      canonicalHost: "example.com",
      locale,
      defaultLocale: "en",
      locales: ["en", "ja", "vi"],
      brand: {
        primaryColor: String(settings.primaryColor ?? "#FA5600"),
        logo: "",
      },
    },
    settings,
    menus,
    locale,
    t: (key: string, vars?: Record<string, string | number>) => {
      const template = flat[key] ?? base[key] ?? key;
      return template.replace(/\{(\w+)\}/g, (_m, name: string) =>
        vars && name in vars ? String(vars[name]) : `{${name}}`,
      );
    },
    renderBlocks: (blocks: unknown[]): ReactNode =>
      (blocks ?? []).map((raw, index) => {
        const block = raw as { id?: string; type: string; props?: Record<string, unknown> };
        const Component = theme.blocks?.[block.type];
        if (!Component) return null;
        return createElement(Component as never, {
          key: block.id ?? index,
          block,
          props: block.props ?? {},
          ctx,
        } as never);
      }),
    hasCapability: () => false,
    // No plugin is installed in a screenshot run, so there is no integration to
    // project and nothing to put in a slot. Both agree with `hasCapability` above:
    // the theme is photographed as it renders on a site with no plugins.
    getIntegration: () => undefined,
    renderSlot: () => null,
    // The theme's declared collections, run against its own demo content — which is
    // exactly what cms-api will run them against on a freshly seeded site.
    //
    // This is what keeps the screenshot honest. A theme whose front page invents its
    // headlines would look identical here to one that lists real posts; resolving the
    // collections for real means a theme that forgot to write demo posts photographs
    // its own empty state, and has to fix it.
    collections: resolveCollections(manifest, locale),
    // Built by the same function the runtime uses, so a theme that hides its toggle
    // in production hides it in the screenshot too — and a dark-only theme is
    // photographed as the dark-only theme it is.
    colorMode: resolveColorModes(manifest, settings),
    url: (p: string) => (locale === "en" ? p || "/" : `/${locale}${p === "/" ? "" : p}`),
    asset: (p: string) =>
      /^([a-z]+:)?\/\//i.test(p) || p.startsWith("/")
        ? p
        : pathToFileURL(path.join(themeDir, p)).href,
    // Three languages, so every theme's switcher is exercised in the shot rather
    // than hidden — it only renders itself when there is more than one.
    alternates: ["en", "ja", "vi"].map((code) => ({
      locale: code,
      path: code === "en" ? "/" : `/${code}`,
      current: code === locale,
      flagUrl: null,
    })),
  } as unknown as ThemeContext<Record<string, unknown>>;

  return ctx;
}

/**
 * The theme's `manifest.collections`, resolved against its own demo content.
 *
 * A stand-in for what cms-api does with a database: filter to the locale and the
 * content type, sort, take `limit`. The rules are copied deliberately rather than
 * imported — cms-api is a Nest service with Prisma behind it, and a screenshot script
 * has no business booting one — but the ORDER and the LIMIT must match, or the
 * picture is of a page nobody will ever see.
 */
function resolveCollections(
  manifest: ThemeManifest & { demo?: { contents?: DemoContent[] } },
  locale: string,
): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  const demo = manifest.demo?.contents ?? [];

  for (const [name, query] of Object.entries(manifest.collections ?? {})) {
    const rows = demo
      .filter((c) => c.contentType === query.contentType && c.locale === locale)
      .slice(0, clampCollectionLimit(query.limit))
      .map((c, index) =>
        toContent(c, c.slug ? `/${prefixFor(manifest, c.contentType)}${c.slug}` : "/", index),
      );

    // Present even when empty — themes are documented as being able to map over a
    // declared collection without a guard, so the screenshot must exercise that too.
    out[name] = rows;
  }

  return out;
}

/** "post" -> "blog/", from the demo content types the theme ships. */
function prefixFor(
  manifest: ThemeManifest & { demo?: { contentTypes?: { key: string; routePrefix?: string }[] } },
  contentType: string,
): string {
  const prefix = manifest.demo?.contentTypes?.find((c) => c.key === contentType)?.routePrefix;
  return prefix ? `${prefix}/` : "";
}

/** { a: { b: 1 } } -> { "a.b": 1 }. The same shape the SDK's translator uses. */
function flatten(input: Record<string, unknown>, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(out, flatten(value as Record<string, unknown>, full));
    } else if (typeof value === "string") {
      out[full] = value;
    }
  }
  return out;
}

/**
 * A ContentDto, faked from a demo row.
 *
 * `index` staggers the publication dates a day apart. A list of six posts all stamped
 * with the same minute is a list whose "newest first" ordering is meaningless and
 * whose dateline reads identically six times — which looks like a rendering bug in a
 * screenshot, and would be one on a real site.
 */
function toContent(demo: DemoContent, path_: string, index = 0) {
  const day = String(14 - Math.min(index, 13)).padStart(2, "0");
  const published = `2026-05-${day}T09:00:00.000Z`;

  return {
    id: `demo-${demo.contentType}-${demo.slug || "home"}`,
    siteId: "screenshot",
    contentType: { id: demo.contentType, key: demo.contentType, name: demo.contentType },
    locale: demo.locale,
    translationGroupId: "demo",
    title: demo.title,
    slug: demo.slug,
    path: path_,
    excerpt: demo.excerpt ?? null,
    data: demo.data ?? {},
    blocks: demo.blocks ?? [],
    seo: {},
    status: "PUBLISHED",
    publishedAt: published,
    author: { id: "a", name: "Z-SOFT Editorial" },
    createdAt: published,
    updatedAt: published,
  };
}

// -------------------------------------------------------------------- rendering

function document_(html: string, css: string, mode: "light" | "dark"): string {
  // `data-theme` and `color-scheme` on <html> is precisely what site-runtime's
  // colour-mode script sets at run time. Setting it statically here is what makes a
  // dark screenshot a screenshot of dark mode, and not of a theme in the dark.
  //
  // The icon rules are the runtime's, restated: <ColorModeToggle> renders BOTH
  // glyphs and the runtime's global stylesheet shows one. Without them the toggle in
  // every screenshot would wear a sun and a moon at the same time.
  const icons = `
[${COLOR_MODE_ICON_ATTRIBUTE}="dark"] { display: none; }
html[${COLOR_MODE_ATTRIBUTE}="dark"] [${COLOR_MODE_ICON_ATTRIBUTE}="dark"] { display: revert; }
html[${COLOR_MODE_ATTRIBUTE}="dark"] [${COLOR_MODE_ICON_ATTRIBUTE}="light"] { display: none; }`;

  return `<!doctype html>
<html lang="en" ${COLOR_MODE_ATTRIBUTE}="${mode}" style="color-scheme:${mode}">
<head><meta charset="utf-8">
<style>
  *,::before,::after{box-sizing:border-box}
  body{margin:0}
  ${icons}
  ${css}
</style>
</head>
<body>${html}</body>
</html>`;
}

/**
 * Takes the picture.
 *
 * Chrome writes the PNG and then, in `--headless=new`, frequently does not exit —
 * it sits there holding the profile open. Waiting for the process is therefore not
 * a way to know the screenshot is done; the FILE is. So this waits for the PNG to
 * appear and stop growing, and then kills the browser itself.
 *
 * "Stop growing" rather than "appear": Chrome creates the file and then streams the
 * encoded image into it, so a screenshot read the instant it exists is a truncated
 * one. Two identical sizes in a row means the write is finished.
 */
async function shoot(htmlPath: string, outPath: string): Promise<void> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcms-shot-"));
  fs.rmSync(outPath, { force: true });

  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--hide-scrollbars",
      "--force-color-profile=srgb",
      // The theme's own logo and icons are loaded over file://, which Chrome treats
      // as cross-origin from the file:// document unless told otherwise. Without
      // this the shot has holes where the branding should be.
      "--allow-file-access-from-files",
      // Let CSS transitions and web fonts settle before the shutter, instead of
      // photographing the page mid-fade.
      "--virtual-time-budget=4000",
      "--run-all-compositor-stages-before-draw",
      `--user-data-dir=${userDataDir}`,
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      `--screenshot=${outPath}`,
      pathToFileURL(htmlPath).href,
    ],
    { stdio: "ignore" },
  );

  try {
    let previous = -1;
    for (let attempt = 0; attempt < 120; attempt++) {
      await sleep(500);

      const size = fs.existsSync(outPath) ? fs.statSync(outPath).size : -1;
      if (size > 0 && size === previous) return;
      previous = size;
    }
    throw new Error(`Chrome produced no screenshot at ${outPath} within 60s`);
  } finally {
    chrome.kill("SIGKILL");
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ------------------------------------------------------------------------- main

const themeDirs = process.argv.slice(2);
if (themeDirs.length === 0) {
  console.error("usage: tsx scripts/theme-screenshots.mts <theme-dir> [...]");
  process.exit(1);
}

for (const name of themeDirs) {
  const dir = path.join(REPO, "themes", name);
  const { theme, css } = await loadTheme(dir);
  const manifest = theme.manifest as ThemeManifest & {
    media?: { screenshots?: string[] };
    demo?: { contents?: DemoContent[] };
  };

  const targets = manifest.media?.screenshots ?? [];
  if (targets.length === 0) {
    console.log(`${name}: manifest declares no screenshots — nothing to take.`);
    continue;
  }

  const contents = manifest.demo?.contents ?? [];
  const english = contents.filter((c) => c.locale === "en");

  const home = english.find((c) => c.slug === "");
  // The "single item" shot: a product where the theme sells things, a post where it
  // publishes them, and any inner page as a last resort.
  const item =
    english.find((c) => c.contentType === "product") ??
    english.find((c) => c.contentType === "post") ??
    english.find((c) => c.slug !== "");

  if (!home || !item) {
    throw new Error(
      `${name}: needs an English demo home page (slug "") and one inner page in theme.json demo.contents.`,
    );
  }

  const shots = [
    { file: targets[0], mode: "light" as const, content: home, kind: "home" as const },
    { file: targets[1], mode: "dark" as const, content: home, kind: "home" as const },
    { file: targets[2], mode: "light" as const, content: item, kind: "item" as const },
  ].filter((s): s is typeof s & { file: string } => Boolean(s.file));

  for (const shot of shots) {
    const ctx = buildContext(theme, dir, "en");

    const Template =
      shot.kind === "home"
        ? (theme.templates.home ?? theme.templates.page)
        : shot.content.contentType === "post"
          ? (theme.templates.post ?? theme.templates.page)
          : theme.templates.page;

    const content = toContent(
      shot.content,
      shot.content.slug ? `/${shot.content.slug}` : "/",
    );

    const markup = renderToStaticMarkup(
      createElement(
        theme.Layout as never,
        { ctx } as never,
        createElement(Template as never, { ctx, content } as never),
      ),
    );

    const tmpHtml = path.join(os.tmpdir(), `zcms-${name}-${path.basename(shot.file)}.html`);
    const tmpPng = path.join(os.tmpdir(), `zcms-${name}-${path.basename(shot.file)}.raw.png`);
    fs.writeFileSync(tmpHtml, document_(markup, css, shot.mode));

    await shoot(tmpHtml, tmpPng);

    const out = path.join(dir, shot.file);
    fs.mkdirSync(path.dirname(out), { recursive: true });

    // The marketplace refuses a screenshot over 2 MB or 4096px on a side, and it
    // re-checks at publish time — so it is normalised here rather than discovered
    // to be too big at the end of a release.
    await sharp(tmpPng).png({ compressionLevel: 9, palette: false }).toFile(out);

    const { size } = fs.statSync(out);
    console.log(
      `${name}: ${shot.file} (${shot.mode}, ${(size / 1024).toFixed(0)} KB)`,
    );

    fs.rmSync(tmpHtml, { force: true });
    fs.rmSync(tmpPng, { force: true });
  }
}
