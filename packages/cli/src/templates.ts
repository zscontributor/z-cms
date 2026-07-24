import { createRequire } from "node:module";

import type { PackageKind } from "@zcmsorg/package";

/**
 * What `zcms init` writes to disk.
 *
 * These templates are not decoration. Two contracts in this platform are
 * invisible from the outside, unforgiving when broken, and — until now — written
 * down nowhere an author would look:
 *
 *   PLUGIN: the sandbox evaluates ONE CommonJS file inside a V8 isolate and
 *           hands it exactly one module, `@zcmsorg/plugin-sdk`. There is no module
 *           resolver in there. A plugin compiled with `tsc` across two source
 *           files emits `require("./helper")`, which the sandbox refuses — and it
 *           does so at *activation* time, on a site, long after the author's
 *           tests passed. So the template bundles to a single CJS file with the
 *           SDK external.
 *
 *   THEME:  site-runtime imports the theme by `file://` URL, so the entry is a
 *           native ES module. It must be `.mjs`: a `dist/index.js` containing
 *           `import` gets its format from the nearest package.json `"type"`, and
 *           package.json ships inside the payload — get it wrong and the runtime
 *           throws "Cannot use import statement outside a module", catches it,
 *           and silently falls back to the default theme. React is EXTERNAL, so
 *           the theme renders with the host's React instance rather than a second
 *           copy of it.
 *
 * Both are encoded here so that an author who changes nothing gets a package that
 * installs, and an author who changes something has a working thing to diff
 * against.
 */

export interface TemplateVars {
  kind: PackageKind;
  /** Reverse-DNS id, e.g. "com.acme.plugin.hello". */
  id: string;
  /** Human name, e.g. "Hello". */
  name: string;
  /** npm package name for the author's own repo, e.g. "zcms-plugin-hello". */
  packageName: string;
  description: string;
  version: string;
  authorName: string;
  authorUrl: string;
}

/**
 * The SDK version a scaffolded package builds against.
 *
 * A caret, not a pin: an author who scaffolds today should get the SDK's patch
 * fixes without editing anything, and the SDK's major is what the manifest's
 * `engine` range already speaks about.
 *
 * Derived from this CLI's own version rather than written down, because the CLI
 * and the SDKs are published from this repo in lockstep, at one version. Hard-
 * coding the range meant that shipping a 0.2.0 CLI while forgetting to edit this
 * line scaffolded projects that silently pinned the *previous* SDK — a mismatch
 * an author would only meet later, as a type error in code they did not write.
 *
 * Read through `createRequire` rather than imported: `rootDir` is ./src, so a
 * static import of ../package.json does not typecheck. This resolves correctly
 * both from dist/main.js when installed and from src/ under `tsx`.
 */
const { version: CLI_VERSION } = createRequire(__filename)("../package.json") as {
  version: string;
};

const SDK_RANGE = `^${CLI_VERSION}`;
const CLI_RANGE = `^${CLI_VERSION}`;
const ENGINE_RANGE = `>=${CLI_VERSION}`;

const ESBUILD_RANGE = "^0.25.12";
const TYPESCRIPT_RANGE = "^5.9.3";
const VITEST_RANGE = "^4.1.10";
const REACT_RANGE = "^19.2.7";
const REACT_TYPES_RANGE = "^19.2.17";

/** A file map: relative path -> contents. */
export type Files = Record<string, string>;

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function author(vars: TemplateVars): { name: string; url?: string } {
  return vars.authorUrl
    ? { name: vars.authorName, url: vars.authorUrl }
    : { name: vars.authorName };
}

/**
 * Never commit the private key, never commit the package.
 *
 * `*.pem` is the load-bearing line. `zcms keygen` writes the publisher's private
 * key into the project directory because that is where an author runs it, and a
 * private key pushed to a public repo ends the publisher's identity — every
 * package it ever signed has to be treated as forgeable.
 */
const GITIGNORE = `node_modules/
dist/

# The publisher's private key. Committing this ends your publisher identity:
# anyone who has it can sign a package as you.
*.pem

# Built packages. Rebuild them; do not track them.
*.zcms
`;

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

function pluginFiles(vars: TemplateVars): Files {
  const manifest = {
    id: vars.id,
    name: vars.name,
    version: vars.version,
    description: vars.description,
    author: author(vars),
    engine: ENGINE_RANGE,
    entry: "dist/index.js",

    // The consent screen shows this list verbatim, and the gateway rejects any
    // call outside it. Ask for the narrowest set that makes the plugin work.
    permissions: ["content:read"],

    // What this plugin offers to THEMES. A theme feature-detects on these, which
    // is what lets a site swap one SEO plugin for another without a theme change.
    capabilities: [],

    settingsSchema: {
      type: "object",
      properties: {
        titleSuffix: {
          type: "string",
          title: "Title suffix",
          description: 'Appended to every meta title, e.g. " | Acme".',
          default: "",
        },
        enabled: {
          type: "boolean",
          title: "Enabled",
          default: true,
        },
      },
    },
  };

  const pkg = {
    name: vars.packageName,
    version: vars.version,
    private: true,
    description: vars.description,
    scripts: {
      build: "node build.mjs",
      typecheck: "tsc --noEmit",
      test: "vitest run",
      keygen: "zcms keygen",
      pack: `zcms pack . --kind plugin --key publisher-private.pem --pub publisher-public.pem`,
      verify: `zcms verify ${vars.id}-${vars.version}.zcms`,
    },
    devDependencies: {
      "@zcmsorg/cli": CLI_RANGE,
      "@zcmsorg/plugin-sdk": SDK_RANGE,
      esbuild: ESBUILD_RANGE,
      typescript: TYPESCRIPT_RANGE,
      vitest: VITEST_RANGE,
    },
  };

  return {
    "plugin.json": json(manifest),
    "package.json": json(pkg),
    ".gitignore": GITIGNORE,

    "build.mjs": `import esbuild from "esbuild";

/**
 * Builds this plugin into the one file the sandbox can run.
 *
 * The plugin sandbox is a V8 isolate. It evaluates a single CommonJS script and
 * provides exactly one module — "@zcmsorg/plugin-sdk". There is no module
 * resolver, no node_modules, no filesystem. So:
 *
 *   bundle: true     — everything you import lands in the one file. Split your
 *                      source across as many files as you like; a relative
 *                      require() would fail at activation time, not at build time.
 *   format: "cjs"    — the sandbox wraps the code in (module, exports, require).
 *                      A top-level \`import\` is a SyntaxError in there.
 *   external: [sdk]  — the sandbox supplies it. Bundling a copy would shadow the
 *                      real one.
 */
await esbuild.build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "es2022",
  external: ["@zcmsorg/plugin-sdk"],
  logLevel: "warning",
});

console.log("${vars.packageName}: dist/index.js");
`,

    "tsconfig.json": json({
      compilerOptions: {
        target: "ES2022",
        lib: ["ES2023"],
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        noUncheckedIndexedAccess: true,
        esModuleInterop: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
        resolveJsonModule: true,
        isolatedModules: true,
        // esbuild emits the JavaScript; tsc is here to typecheck, not to build.
        noEmit: true,
        // No node types: nothing the sandbox provides comes from Node. If `fs` or
        // `process` typechecks in your plugin, the type is lying to you.
        types: [],
      },
      include: ["src/**/*.ts", "test/**/*.ts", "plugin.json"],
    }),

    "src/index.ts": `import { definePlugin, type PluginManifest } from "@zcmsorg/plugin-sdk";
import manifestJson from "../plugin.json";

/**
 * ${vars.name}
 *
 * ${vars.description}
 *
 * The manifest is read from plugin.json rather than declared twice: that file is
 * what the packer signs and what the admin's consent screen renders, so a copy
 * here that drifted from it would be a lie that still compiled.
 *
 * Note what this file does NOT have: no filesystem import, no network client, no
 * environment variables, no database handle. Not out of politeness — the sandbox
 * does not provide them, and the publish-time scanner rejects a package that
 * reaches for them. Everything the platform grants arrives as \`ctx\`.
 */

const manifest = manifestJson as unknown as PluginManifest;

/** Mirrors \`settingsSchema\` in plugin.json. The admin renders that form. */
interface Settings {
  titleSuffix: string;
  enabled: boolean;
}

export default definePlugin<Settings>({
  manifest,

  filters: {
    /**
     * A FILTER transforms a value on its way through the render path, so it runs
     * under a hard timeout — overrun and the platform drops the result and uses
     * the original. Never take a page down from in here.
     *
     * This one only ever FILLS A GAP: it appends a suffix, and leaves a title an
     * editor wrote by hand alone. A plugin that silently overwrote an author's
     * work would be a bug, not a feature.
     */
    "content.seo": (seo, content, ctx) => {
      if (!ctx.settings.enabled) return seo;

      const suffix = ctx.settings.titleSuffix ?? "";
      const title = seo.title ?? content.title;

      return {
        ...seo,
        title: !suffix || title.endsWith(suffix) ? title : \`\${title}\${suffix}\`,
      };
    },
  },

  actions: {
    /**
     * An ACTION reacts after the fact, off the request path — the editor's
     * publish has already returned. Do the slow, useful thing here.
     *
     * \`ctx.storage\` is this plugin's own namespaced key-value space. It needs no
     * schema, no migration, and no permission: nothing else can read it.
     */
    "content.published": async (event, ctx) => {
      await ctx.storage.set(\`seen:\${event.contentId}\`, {
        path: event.path,
        title: event.title,
        at: event.publishedAt,
      });

      ctx.log.info(\`${vars.name}: \${event.path} was published.\`);
    },
  },

  /** Runs once, when an admin activates this plugin on a site. */
  setup: async (ctx) => {
    ctx.log.info(\`${vars.name} activated on "\${ctx.site.name}".\`);
  },
});
`,

    "test/plugin.test.ts": `import { describe, expect, it } from "vitest";
import plugin from "../src/index";

/**
 * The manifest is the plugin's contract with the admin who installs it: the id it
 * is known by, and the permissions they are asked to grant. A change to either is
 * a change to that contract, so it should have to be made on purpose.
 */
describe("${vars.name}", () => {
  it("keeps its identity and the permissions it asks for explicit", () => {
    expect(plugin.manifest.id).toBe("${vars.id}");
    expect(plugin.manifest.permissions).toEqual(["content:read"]);
  });

  it("does not overwrite a meta title an editor wrote by hand", () => {
    const seo = plugin.filters?.["content.seo"];
    if (!seo) throw new Error("the content.seo filter is missing");

    const result = seo(
      { title: "Written by hand" },
      { title: "Page title" } as never,
      { settings: { titleSuffix: " | Acme", enabled: true } } as never,
    );

    expect(result).toMatchObject({ title: "Written by hand | Acme" });
  });
});
`,

    "README.md": pluginReadme(vars),
  };
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

function themeFiles(vars: TemplateVars): Files {
  const manifest = {
    id: vars.id,
    name: vars.name,
    version: vars.version,
    kind: "theme",
    description: vars.description,
    author: author(vars),
    engine: ENGINE_RANGE,

    // .mjs, not .js — the runtime imports this by file:// URL, and a `.js` file's
    // module format is decided by the nearest package.json "type", which travels
    // inside the package. An .mjs extension is ESM no matter what.
    entry: "dist/index.mjs",

    // A theme carries its own CSS. The host's stylesheet was generated by scanning
    // the host's source, so it has never seen this theme's class names: relying on
    // it would render correct markup with no styling at all.
    styles: "dist/theme.css",

    templates: ["home", "page", "post", "archive", "notFound", "error"],
    menuLocations: [
      { key: "primary", name: "Primary menu" },
      { key: "footer", name: "Footer menu" },
    ],

    seo: {
      // "%s" is the page's own title, "%site%" the site name.
      titleTemplate: "%s — %site%",
      robots: { index: true, follow: true },
    },

    settingsSchema: {
      type: "object",
      properties: {
        // Empty by default, and that is load-bearing: any non-empty default would
        // be truthy on every site, and the site's own brand colour could never
        // show through. Blank means "use the site's brand".
        accent: {
          type: "string",
          title: "Accent colour",
          format: "color",
          description: "Leave empty to use the site's brand colour.",
          default: "",
        },
        siteTitle: { type: "string", title: "Site title", default: vars.name },
        tagline: { type: "string", title: "Tagline", default: "" },
        footerText: {
          type: "string",
          title: "Footer text",
          default: `© ${vars.authorName}`,
        },
      },
    },
  };

  const pkg = {
    name: vars.packageName,
    version: vars.version,
    private: true,
    type: "module",
    description: vars.description,
    scripts: {
      build: "node build.mjs",
      typecheck: "tsc --noEmit",
      keygen: "zcms keygen",
      pack: `zcms pack . --kind theme --key publisher-private.pem --pub publisher-public.pem`,
      verify: `zcms verify ${vars.id}-${vars.version}.zcms`,
    },
    // React is a peer, never a dependency: the theme renders inside the host's
    // React tree, and a second copy of React in one render is the classic way to
    // produce "invalid hook call" in production only.
    peerDependencies: {
      react: "^19.0.0",
    },
    devDependencies: {
      "@types/react": REACT_TYPES_RANGE,
      "@zcmsorg/cli": CLI_RANGE,
      "@zcmsorg/schemas": SDK_RANGE,
      "@zcmsorg/theme-sdk": SDK_RANGE,
      esbuild: ESBUILD_RANGE,
      react: REACT_RANGE,
      typescript: TYPESCRIPT_RANGE,
    },
  };

  return {
    "theme.json": json(manifest),
    "package.json": json(pkg),
    ".gitignore": GITIGNORE,

    "build.mjs": `import esbuild from "esbuild";
import fs from "node:fs";

/**
 * Builds this theme into a distributable bundle.
 *
 * Three decisions here are what make a theme installable rather than merely
 * present on your disk:
 *
 * 1. OUTPUT IS ESM, AND THE FILE IS .mjs. site-runtime imports the entry by
 *    file:// URL. A dist/index.js full of \`import\` would take its format from
 *    the nearest package.json "type" — which ships inside the package — and the
 *    failure mode is not an error you see: the runtime catches it and silently
 *    falls back to the default theme.
 *
 * 2. REACT IS EXTERNAL. The bundle resolves react from the host at import time,
 *    so the theme renders with the SAME React instance as the runtime. Bundle a
 *    second copy and you get "invalid hook call" — in production, only.
 *
 * 3. THE THEME SHIPS ITS OWN CSS. The host's stylesheet was built by scanning the
 *    host's source; it has never seen this theme. The runtime serves this file
 *    out of the verified package directory.
 */
await esbuild.build({
  entryPoints: ["src/index.tsx"],
  outfile: "dist/index.mjs",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  jsx: "automatic",
  external: ["react", "react/jsx-runtime", "react-dom"],
  logLevel: "warning",
});

fs.copyFileSync("src/theme.css", "dist/theme.css");

console.log("${vars.packageName}: dist/index.mjs + dist/theme.css");
`,

    "tsconfig.json": json({
      compilerOptions: {
        target: "ES2022",
        lib: ["ES2023", "DOM"],
        module: "ESNext",
        moduleResolution: "Bundler",
        jsx: "react-jsx",
        strict: true,
        noUncheckedIndexedAccess: true,
        esModuleInterop: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
        resolveJsonModule: true,
        isolatedModules: true,
        // esbuild emits the bundle; tsc is here to typecheck, not to build.
        noEmit: true,
        types: ["react"],
      },
      include: ["src/**/*.ts", "src/**/*.tsx", "theme.json"],
    }),

    "src/index.tsx": themeSource(vars),
    "src/theme.css": THEME_CSS,
    "src/locales/en.json": json({
      "nav.primary": "Primary",
      "nav.footer": "Footer",
      "archive.empty": "Nothing here yet.",
      "archive.previous": "Previous",
      "archive.next": "Next",
      "archive.pageOf": "Page {page} of {total}",
      "notFound.title": "Page not found",
      "notFound.description": "The page you asked for does not exist.",
      "notFound.backHome": "Back to the homepage",
      "error.title": "Something went wrong",
      "error.description": "Please try again in a moment.",
      "error.reference": "Reference",
      "error.backHome": "Back to the homepage",
    }),

    "README.md": themeReadme(vars),
  };
}

function themeSource(vars: TemplateVars): string {
  return `import {
  defineTheme,
  type ArchiveTemplateProps,
  type BlockProps,
  type ErrorTemplateProps,
  type LayoutProps,
  type NotFoundTemplateProps,
  type PageTemplateProps,
  type ThemeManifest,
} from "@zcmsorg/theme-sdk";
import manifestJson from "../theme.json";
import en from "./locales/en.json";

/**
 * ${vars.name}
 *
 * ${vars.description}
 *
 * This file imports exactly one thing from the platform: @zcmsorg/theme-sdk. No
 * database, no API client, no Next.js. That is what makes a theme a *package* —
 * something a site installs — rather than something you deploy.
 *
 * Everything a template can see arrives as \`ctx\`, and everything an owner can
 * change arrives as \`ctx.settings\`, generated from the settingsSchema in
 * theme.json. A colour hardcoded here is a colour the site owner can never change.
 */

const manifest = manifestJson as unknown as ThemeManifest;

/** Mirrors \`settingsSchema\` in theme.json. The admin renders that form. */
interface Settings {
  accent: string;
  siteTitle: string;
  tagline: string;
  footerText: string;
}

// ---------------------------------------------------------------------------
// Layout — wraps every page.
// ---------------------------------------------------------------------------

function Layout({ ctx, children }: LayoutProps<Settings>) {
  const { settings, menus } = ctx;
  const primary = menus.primary?.items ?? [];
  const footer = menus.footer?.items ?? [];

  return (
    <div
      className="t"
      // The accent arrives as data. This theme's own setting wins when it is
      // filled in; blank falls through to the SITE's brand colour, which belongs
      // to the site and outlives any one theme.
      style={{ ["--accent" as string]: settings.accent || ctx.site.brand.primaryColor }}
    >
      <header className="t__header">
        <div className="t__wrap t__bar">
          <a className="t__brand" href={ctx.url("/")}>
            {ctx.site.brand.logo ? (
              <img className="t__logo" src={ctx.site.brand.logo} alt="" />
            ) : (
              <span className="t__brand-name">{settings.siteTitle}</span>
            )}
          </a>

          {primary.length > 0 ? (
            <nav className="t__nav" aria-label={ctx.t("nav.primary")}>
              {primary.map((item) => (
                <a key={item.id} href={item.url} target={item.target}>
                  {item.label}
                </a>
              ))}
            </nav>
          ) : null}
        </div>
      </header>

      <main className="t__main">
        <div className="t__wrap">{children}</div>
      </main>

      <footer className="t__footer">
        <div className="t__wrap t__bar">
          <span>{settings.footerText}</span>
          {footer.length > 0 ? (
            <nav className="t__nav" aria-label={ctx.t("nav.footer")}>
              {footer.map((item) => (
                <a key={item.id} href={item.url} target={item.target}>
                  {item.label}
                </a>
              ))}
            </nav>
          ) : null}
        </div>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Templates — one per kind of page the runtime can ask for.
// ---------------------------------------------------------------------------

function formatDate(iso: string | null, locale: string): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(locale, {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function Home({ ctx, content }: PageTemplateProps<Settings>) {
  return (
    <article>
      {ctx.settings.tagline ? (
        <p className="t__lede">{ctx.settings.tagline}</p>
      ) : null}
      <div className="t__prose">{ctx.renderBlocks(content.blocks)}</div>
    </article>
  );
}

function Page({ ctx, content }: PageTemplateProps<Settings>) {
  return (
    <article>
      <h1 className="t__title">{content.title}</h1>
      {content.excerpt ? <p className="t__lede">{content.excerpt}</p> : null}
      <div className="t__prose">{ctx.renderBlocks(content.blocks)}</div>
    </article>
  );
}

function Post({ ctx, content }: PageTemplateProps<Settings>) {
  return (
    <article>
      <p className="t__meta">
        {formatDate(content.publishedAt, ctx.locale)}
        {content.author ? \` · \${content.author.name}\` : ""}
      </p>
      <h1 className="t__title">{content.title}</h1>
      {content.excerpt ? <p className="t__lede">{content.excerpt}</p> : null}
      <div className="t__prose">{ctx.renderBlocks(content.blocks)}</div>
    </article>
  );
}

function Archive({ ctx, archive }: ArchiveTemplateProps<Settings>) {
  return (
    <section>
      <h1 className="t__title">{archive.title}</h1>

      {archive.items.length === 0 ? (
        <p className="t__lede">{ctx.t("archive.empty")}</p>
      ) : (
        <ul className="t__list">
          {archive.items.map((item) => (
            <li key={item.id}>
              <p className="t__meta">{formatDate(item.publishedAt, ctx.locale)}</p>
              <h2>
                <a href={ctx.url(item.path)}>{item.title}</a>
              </h2>
              {item.excerpt ? <p>{item.excerpt}</p> : null}
            </li>
          ))}
        </ul>
      )}

      {archive.totalPages > 1 ? (
        <p className="t__meta">
          {archive.page > 1 ? (
            <a href={\`\${archive.basePath}?page=\${archive.page - 1}\`}>
              ← {ctx.t("archive.previous")}
            </a>
          ) : null}{" "}
          {ctx.t("archive.pageOf", { page: archive.page, total: archive.totalPages })}{" "}
          {archive.page < archive.totalPages ? (
            <a href={\`\${archive.basePath}?page=\${archive.page + 1}\`}>
              {ctx.t("archive.next")} →
            </a>
          ) : null}
        </p>
      ) : null}
    </section>
  );
}

function NotFound({ ctx }: NotFoundTemplateProps<Settings>) {
  return (
    <section>
      <p className="t__meta">404</p>
      <h1 className="t__title">{ctx.t("notFound.title")}</h1>
      <p className="t__lede">{ctx.t("notFound.description")}</p>
      <a className="t__cta" href={ctx.url("/")}>
        {ctx.t("notFound.backHome")}
      </a>
    </section>
  );
}

function ErrorPage({ ctx, statusCode, title, message, digest }: ErrorTemplateProps<Settings>) {
  return (
    <section>
      <p className="t__meta">{statusCode}</p>
      <h1 className="t__title">{title || ctx.t("error.title")}</h1>
      <p className="t__lede">{message || ctx.t("error.description")}</p>
      {digest ? (
        <p className="t__meta">
          {ctx.t("error.reference")}: {digest}
        </p>
      ) : null}
      <a className="t__cta" href={ctx.url("/")}>
        {ctx.t("error.backHome")}
      </a>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Blocks — how this theme draws the core content blocks an editor can place.
//
// A block your theme does not implement simply does not render, so implement at
// least the ones your sites will use.
// ---------------------------------------------------------------------------

const str = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

function Hero({ props }: BlockProps<Record<string, unknown>, Settings>) {
  return (
    <section className="t__hero">
      <h1 className="t__title">{str(props.heading)}</h1>
      {props.subheading ? <p className="t__lede">{str(props.subheading)}</p> : null}
      {props.ctaLabel && props.ctaHref ? (
        <a className="t__cta" href={str(props.ctaHref)}>
          {str(props.ctaLabel)}
        </a>
      ) : null}
    </section>
  );
}

function RichText({ props }: BlockProps<Record<string, unknown>, Settings>) {
  // The HTML comes from the editor — a trusted author inside the CMS, the same
  // trust boundary as any WYSIWYG. It is NOT visitor-submitted content.
  return (
    <div className="t__prose" dangerouslySetInnerHTML={{ __html: str(props.html) }} />
  );
}

function ImageBlock({ props }: BlockProps<Record<string, unknown>, Settings>) {
  const src = str(props.src ?? props.url);
  if (!src) return null;

  return (
    <figure className="t__figure">
      <img src={src} alt={str(props.alt)} loading="lazy" />
      {props.caption ? <figcaption>{str(props.caption)}</figcaption> : null}
    </figure>
  );
}

export default defineTheme<Settings>({
  manifest,
  Layout,
  templates: {
    home: Home,
    page: Page,
    post: Post,
    archive: Archive,
    notFound: NotFound,
    error: ErrorPage,
  },
  blocks: {
    "core/hero": Hero,
    "core/richtext": RichText,
    "core/image": ImageBlock,
  },

  // This theme's strings travel inside this theme's package: it is installed and
  // removed on its own schedule, so its catalogue cannot live in core. English is
  // the base — a locale nobody has translated this theme into still renders.
  messages: { en },

  // Settings -> document head. The owner renames the site in the admin and the
  // <title> follows, with no change to core and no change to this file.
  seo: (ctx) => ({
    defaultTitle: ctx.settings.siteTitle || undefined,
    description: ctx.settings.tagline || undefined,
    icons: { themeColor: ctx.settings.accent || ctx.site.brand.primaryColor },
  }),
});
`;
}

const THEME_CSS = `/* This theme's own stylesheet. It ships inside the package and the runtime
   serves it from the verified package directory — the host's stylesheet has
   never seen these class names. */

.t {
  --accent: #fa5600;
  --ink: #16181d;
  --muted: #6b7280;
  --line: #e5e7eb;
  --bg: #ffffff;

  background: var(--bg);
  color: var(--ink);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  line-height: 1.6;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.t__wrap {
  margin: 0 auto;
  max-width: 44rem;
  padding: 0 1.25rem;
  width: 100%;
}

.t__bar {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  justify-content: space-between;
}

.t__header {
  border-bottom: 1px solid var(--line);
  padding: 1.25rem 0;
}

.t__brand {
  color: inherit;
  font-weight: 650;
  text-decoration: none;
}

.t__logo {
  display: block;
  height: 2rem;
  width: auto;
}

.t__nav {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
}

.t__nav a {
  color: var(--muted);
  text-decoration: none;
}

.t__nav a:hover {
  color: var(--accent);
}

.t__main {
  flex: 1;
  padding: 3rem 0;
}

.t__footer {
  border-top: 1px solid var(--line);
  color: var(--muted);
  font-size: 0.875rem;
  padding: 1.5rem 0;
}

.t__title {
  font-size: 2.25rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.2;
  margin: 0 0 0.75rem;
}

.t__lede {
  color: var(--muted);
  font-size: 1.125rem;
  margin: 0 0 1.5rem;
}

.t__meta {
  color: var(--muted);
  font-size: 0.875rem;
  margin: 0 0 0.5rem;
}

.t__prose > * + * {
  margin-top: 1rem;
}

.t__prose a {
  color: var(--accent);
}

.t__prose img {
  height: auto;
  max-width: 100%;
}

.t__hero {
  padding: 2rem 0 3rem;
}

.t__cta {
  background: var(--accent);
  border-radius: 0.5rem;
  color: #fff;
  display: inline-block;
  font-weight: 600;
  padding: 0.65rem 1.25rem;
  text-decoration: none;
}

.t__figure {
  margin: 0;
}

.t__figure figcaption {
  color: var(--muted);
  font-size: 0.875rem;
  margin-top: 0.5rem;
}

.t__list {
  display: grid;
  gap: 2rem;
  list-style: none;
  margin: 0;
  padding: 0;
}

.t__list h2 {
  font-size: 1.35rem;
  margin: 0 0 0.35rem;
}

.t__list a {
  color: inherit;
  text-decoration: none;
}

.t__list a:hover {
  color: var(--accent);
}

@media (prefers-color-scheme: dark) {
  .t {
    --ink: #e8eaed;
    --muted: #9aa0a6;
    --line: #2a2d33;
    --bg: #101114;
  }

  .t__cta {
    color: #101114;
  }
}
`;

// ---------------------------------------------------------------------------
// READMEs — the workflow, written where the author will actually look for it.
// ---------------------------------------------------------------------------

function pluginReadme(vars: TemplateVars): string {
  return `# ${vars.name}

${vars.description}

A Z-CMS plugin. It runs inside a V8 sandbox with no filesystem, no network and no
database — everything the platform grants it arrives as \`ctx\`, and nothing it did
not declare in \`plugin.json\` is available to it.

## Develop

\`\`\`sh
pnpm install
pnpm build       # -> dist/index.js  (one CommonJS file — that is what the sandbox runs)
pnpm typecheck
pnpm test
\`\`\`

Split your source across as many files as you like: \`build.mjs\` bundles them into
the single file the sandbox can evaluate. What you must NOT do is import anything
other than \`@zcmsorg/plugin-sdk\` — it is the only module that exists in there, and
the publish-time scanner rejects a package that reaches for \`fs\`, \`fetch\`,
\`process.env\`, \`eval\` or \`new Function\`.

## Publish

\`\`\`sh
pnpm keygen      # once, ever. Writes publisher-private.pem + publisher-public.pem
pnpm build
pnpm pack        # -> ${vars.id}-${vars.version}.zcms  (signed with your private key)
pnpm verify      # checks the signature the way a runtime would
\`\`\`

\`publisher-private.pem\` is your identity. It is in \`.gitignore\` for a reason:
anyone who has it can sign a package as you, and every package you ever signed
has to be treated as forgeable once it leaks. Back it up somewhere a repository
is not.

Register \`publisher-public.pem\` with the marketplace to become a publisher, then
submit the \`.zcms\` file. A package carries YOUR signature when you pack it; a
runtime will not run it until the marketplace has reviewed it and counter-signed.

## What is in here

| File | What it is |
| --- | --- |
| \`plugin.json\` | The manifest. Identity, permissions, and the settings form the admin renders. Signed. |
| \`src/index.ts\` | The plugin: filters, actions, jobs, setup. |
| \`build.mjs\` | esbuild -> one CommonJS file. Read the comment before you change it. |
| \`test/plugin.test.ts\` | Vitest. Filters and actions are plain functions; call them. |

## Permissions

\`plugin.json\` asks for \`content:read\`. The admin sees that list verbatim on the
consent screen and the gateway rejects any call outside it — so ask for the
narrowest set that makes the plugin work, and expect to justify each one.
`;
}

function themeReadme(vars: TemplateVars): string {
  return `# ${vars.name}

${vars.description}

A Z-CMS theme. It renders inside the site runtime's React tree and talks to the
platform through exactly one module: \`@zcmsorg/theme-sdk\`.

## Develop

\`\`\`sh
pnpm install
pnpm build       # -> dist/index.mjs + dist/theme.css
pnpm typecheck
\`\`\`

Two rules the build encodes, and breaking either fails only in production:

- **The entry is \`.mjs\`.** The runtime imports it by \`file://\` URL. A
  \`dist/index.js\` takes its module format from the nearest \`package.json\`
  \`"type"\` — which ships inside the package — and when it guesses wrong the
  runtime catches the error and silently falls back to the default theme.
- **React is external.** The bundle resolves \`react\` from the host, so your
  components run on the host's React instance. A second copy of React in one
  render is how a theme produces "invalid hook call" on a live site and nowhere
  else.

## Publish

\`\`\`sh
pnpm keygen      # once, ever. Writes publisher-private.pem + publisher-public.pem
pnpm build
pnpm pack        # -> ${vars.id}-${vars.version}.zcms  (signed with your private key)
pnpm verify      # checks the signature the way a runtime would
\`\`\`

\`publisher-private.pem\` is your identity — it is in \`.gitignore\` because anyone
who has it can sign a package as you. Back it up somewhere a repository is not.

Register \`publisher-public.pem\` with the marketplace, then submit the \`.zcms\`
file. Your signature says who wrote it; only the marketplace's counter-signature
makes a runtime willing to run it.

## What is in here

| File | What it is |
| --- | --- |
| \`theme.json\` | The manifest. Identity, templates, menu locations, SEO defaults, and the settings form the admin renders. Signed. |
| \`src/index.tsx\` | The theme: Layout, templates, blocks, strings, SEO. |
| \`src/theme.css\` | This theme's stylesheet. It ships in the package; the host's CSS has never seen your class names. |
| \`build.mjs\` | esbuild -> ESM. Read the comment before you change it. |
| \`src/locales/en.json\` | This theme's strings. Add \`vi.json\`, \`ja.json\` and register them in \`messages\`. |

## Settings

Everything an owner should be able to change lives in \`settingsSchema\` in
\`theme.json\`, and the admin generates the form straight from it — you do not
write that form. A colour hardcoded in \`theme.css\` is a colour the site owner can
never change; a colour read from \`ctx.settings\` is one they can.

## Assets

Images this theme ships (\`assets/favicon.ico\`, \`assets/logo.png\`, …) are
addressed with \`ctx.asset("assets/logo.png")\` and served from the verified package
directory. The runtime serves only \`.css .png .jpg .jpeg .webp .svg .woff2 .ico\`
from there — never JavaScript.
`;
}

/** The files a new package of this kind starts life with. */
export function templateFor(vars: TemplateVars): Files {
  return vars.kind === "theme" ? themeFiles(vars) : pluginFiles(vars);
}
