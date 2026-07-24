import type { ComponentType, ReactNode } from "react";
import type {
  Block,
  CollectionQuery,
  ContentDto,
  LocaleAlternate,
  MenuDto,
  PackageMediaDeclaration,
  RenderIntegration,
  RenderPayload,
} from "@zcmsorg/schemas";
import type { ThemeMessageCatalog, Translate } from "./i18n";

// Re-exported so that a theme's only import remains @zcmsorg/theme-sdk: the query
// shape is defined in schemas (cms-api runs it), but a theme author should never
// have to learn that, nor add a second dependency to read their own manifest's type.
export type { CollectionQuery, CollectionSort } from "@zcmsorg/schemas";

/**
 * The Theme SDK is the stable contract between Z-CMS and a theme. A theme
 * imports only from here — never from cms-api or site-runtime internals — which
 * is what allows a theme built today to keep working after core is rewritten.
 *
 * A theme is a package, not a folder of files inside the runtime. It declares
 * what it can render (templates), what it needs (menu locations, settings), and
 * how to draw the core blocks. Core decides *what* to show; the theme decides
 * only *how*.
 */

export interface ThemeAuthor {
  name: string;
  url?: string;
}

export interface MenuLocation {
  key: string;
  name: string;
}

export interface ThemeDemoContentType {
  key: string;
  name: string;
  pluralName: string;
  description?: string;
  isSingleton?: boolean;
  isRoutable?: boolean;
  routePrefix?: string;
  hasBlocks?: boolean;
  icon?: string;
  fields?: unknown[];
}

export interface ThemeDemoContent {
  contentType: string;
  locale: string;
  slug: string;
  title: string;
  translationGroup?: string;
  excerpt?: string;
  data?: Record<string, unknown>;
  blocks?: unknown[];
  seo?: Record<string, unknown>;
  status?: "DRAFT" | "IN_REVIEW" | "SCHEDULED" | "PUBLISHED" | "ARCHIVED";
  publishedAt?: string;
}

export interface ThemeDemoMenu {
  key: string;
  name: string;
  items: {
    label: string;
    url: string;
    target?: string;
    children?: ThemeDemoMenu["items"];
  }[];
}

export interface ThemeDemoData {
  settings?: Record<string, unknown>;
  contentTypes?: ThemeDemoContentType[];
  contents?: ThemeDemoContent[];
  menus?: ThemeDemoMenu[];
}

// ---------------------------------------------------------------------------
// Colour mode (dark / light)
//
// Dark mode is a platform capability, not a theme trick, and the reason is that a
// theme CANNOT implement it correctly on its own:
//
//   - A theme renders on the SERVER and ships no client bundle. It has no way to
//     attach a click handler, and no way to remember a choice.
//   - The preference belongs to the *visitor*, not to the page: it must survive a
//     navigation, and it must be applied BEFORE first paint or the reader gets a
//     white flash on the way to a dark page.
//   - Both of those live on the document — <html> — which belongs to the runtime.
//
// So the runtime owns the mechanism and the theme owns the appearance. The runtime
// sets `data-theme="dark" | "light"` on <html>, remembers the choice, and toggles
// it when a `ColorModeToggle` is clicked. The theme declares which modes it can
// actually draw, decides where the switch goes, and styles itself under
// `html[data-theme="dark"]`.
//
// Note what is deliberately absent: there is no `ctx.colorMode.current`. The server
// does not know which mode this visitor is in — only their browser does — and a
// theme that branched its markup on a guess would render one thing on the server
// and another on the client, which is precisely the flash this design exists to
// prevent. Themes branch in CSS, where being wrong for one frame is impossible.
// ---------------------------------------------------------------------------

/** The two modes a document can be in. */
export type ColorMode = "light" | "dark";

/** A *preference* may also defer to the operating system. */
export type ColorModePreference = ColorMode | "system";

/** What a theme declares in its manifest. */
export interface ThemeColorModes {
  /** The modes the theme is drawn for. Defaults to both. Must not be empty. */
  supports?: ColorMode[];
  /**
   * Where a visitor who has never chosen starts. Defaults to "system" — follow the
   * operating system, which is the only default that is not an opinion about
   * somebody else's eyes.
   */
  default?: ColorModePreference;
}

/** Stable places where the runtime may mount integration UI owned by core. */
export type IntegrationSlot =
  | "header-after"
  | "page-before"
  | "page-after"
  | "footer-before"
  | "floating";

/**
 * `ctx.colorMode` — what the platform tells a theme about colour modes.
 *
 * Resolved from the manifest and the site's settings, so a theme reads one object
 * rather than re-deriving the rules (and disagreeing with the runtime about them).
 */
export interface ColorModeContext {
  /** The modes this theme supports, as resolved. Never empty. */
  modes: ColorMode[];
  /** The starting mode for a visitor who has expressed no preference. */
  default: ColorModePreference;
  /**
   * True when there is genuinely something to switch between.
   *
   * A theme should not need to write `modes.length > 1` — and more importantly it
   * should not be *able* to forget to. `ColorModeToggle` already checks this; a
   * theme that hand-rolls its own switch is expected to as well.
   */
  toggleable: boolean;
  /** The attribute the runtime sets on <html>. Themes style against it. */
  attribute: string;
}

/**
 * JSON Schema describing the theme's settings. The admin renders a settings
 * form straight from this, so a theme adds a customisation option without any
 * change to admin-web.
 */
export interface ThemeSettingsSchema {
  type: "object";
  properties: Record<
    string,
    {
      type: "string" | "number" | "boolean";
      title?: string;
      description?: string;
      format?: "color" | "url" | "image" | "textarea";
      default?: unknown;
      enum?: string[];
    }
  >;
  required?: string[];
}

// ---------------------------------------------------------------------------
// SEO
//
// SEO is a property of the theme, not of core.
//
// The head of a document — its title shape, its icons, its organisation identity,
// its social card — is part of how a site presents itself, and that is exactly
// what a theme decides. Core knows the content; it has no opinion on whether the
// title reads "Post — Site" or "Site | Post", which favicon is right for the
// brand, or what the publisher's legal name is. So the theme declares its
// defaults in the manifest, derives the site-specific parts from its own settings
// at render time, and per-page values (which plugins may have filtered) win over
// both.
// ---------------------------------------------------------------------------

/**
 * The publisher behind the site. Emitted as schema.org `Organization` JSON-LD,
 * which is what search engines read for the knowledge panel: name, logo, and the
 * profiles that confirm the same entity elsewhere.
 */
export interface ThemeOrganization {
  name: string;
  /** Registered legal name, when it differs from the trading name. */
  legalName?: string;
  url?: string;
  /** Absolute URL of the logo. */
  logo?: string;
  email?: string;
  phone?: string;
  address?: {
    street?: string;
    locality?: string;
    region?: string;
    postalCode?: string;
    country?: string;
  };
  /** Profiles that identify the same organisation (social, directories). */
  sameAs?: string[];
}

/**
 * Icons a theme ships or a site overrides.
 *
 * A path is resolved the same way `ctx.asset` resolves one:
 *
 *   - *relative* ("assets/favicon.ico") means an asset the THEME ships, inside
 *     its own package. It is served from that theme's asset base, so two themes
 *     installed on the same platform each get their own favicon and neither can
 *     serve the other's.
 *   - *absolute* ("/uploads/favicon.ico", "https://…") passes through untouched.
 *     This is what a site owner's uploaded favicon is, and it wins over the one
 *     the theme ships.
 *
 * Relative is the reason a favicon belongs to a theme rather than to the runtime:
 * a theme that hardcoded a site-root path like "/favicon.ico" would be claiming a
 * URL it does not own, and every other theme would be claiming the same one.
 */
export interface ThemeIcons {
  /** Classic `favicon.ico`, for browsers that still ask for one. */
  favicon?: string;
  /** Modern icon, usually an SVG or a 512px PNG. */
  icon?: string;
  appleTouchIcon?: string;
  /** Address-bar / PWA colour, e.g. "#FA5600". */
  themeColor?: string;
}

/**
 * SEO the theme ships with. Every field is a default: a page that says otherwise
 * wins, and so does a value the theme derives from its settings.
 */
export interface ThemeSeoDefaults {
  /**
   * How a page title is composed. `%s` is the page's own title.
   * e.g. "%s — Acme" turns "Pricing" into "Pricing — Acme".
   */
  titleTemplate?: string;
  /** Title for pages that have none of their own (the homepage, typically). */
  defaultTitle?: string;
  description?: string;
  /** Social card image used when a page has no image of its own. */
  ogImage?: string;
  /** Twitter/X handle of the site, e.g. "@zsoft". */
  twitterSite?: string;
  /** Default indexing policy. Staging sites set `index: false` here. */
  robots?: { index: boolean; follow: boolean };
  organization?: ThemeOrganization;
  icons?: ThemeIcons;
}

/**
 * What `Theme.seo(ctx)` returns: the same shape, but computed — this is where a
 * theme maps its own settings onto SEO, so a site owner editing "Organisation
 * name" or "Favicon" in the admin changes the rendered head without a code change.
 */
export type ThemeSeoOverrides = ThemeSeoDefaults;

/**
 * The head of one page, fully resolved. The runtime renders this; a theme never
 * touches Next.js metadata itself.
 */
export interface ResolvedSeo {
  /** Already composed through `titleTemplate`. */
  title: string;
  description?: string;
  canonical?: string;
  robots: { index: boolean; follow: boolean };
  ogImage?: string;
  ogType: "website" | "article";
  siteName: string;
  locale: string;
  publishedTime?: string;
  twitterSite?: string;
  icons: ThemeIcons;
  organization?: ThemeOrganization;
}

export type TemplateName =
  | "home"
  | "page"
  | "post"
  | "archive"
  | "search"
  | "notFound"
  | "error";

export interface ThemeManifest {
  /** Reverse-DNS id, e.g. "vn.zsoft.theme.default". */
  id: string;
  name: string;
  version: string;
  description?: string;
  author: ThemeAuthor;
  /** Semver range of the Z-CMS engine this theme supports. */
  engine: string;
  templates: TemplateName[];
  menuLocations: MenuLocation[];
  settingsSchema: ThemeSettingsSchema;
  /**
   * SEO the theme ships with: title shape, icons, organisation identity.
   * Static, so the platform can read it from theme.json without executing the
   * theme. Anything that depends on a site's settings belongs in `Theme.seo`.
   */
  seo?: ThemeSeoDefaults;
  /**
   * What the catalogue shows: up to three screenshots and, optionally, a video.
   *
   * Nobody installs a theme they cannot see. The images live inside the package,
   * so they are covered by the same signature as the code — a screenshot cannot be
   * swapped without breaking it.
   */
  media?: PackageMediaDeclaration;
  /**
   * Which colour modes this theme is actually drawn for.
   *
   * Not a preference — a capability. A theme that ships only a dark palette
   * ("supports": ["dark"]) is not a theme with a broken light mode; it is a theme
   * that has one mode, and the platform must not offer a visitor a switch that
   * lands them on an unstyled page. So the runtime reads this and *forces* the
   * single mode, and `ColorModeToggle` renders nothing.
   *
   * Omitted means ["light", "dark"] with "system": the overwhelmingly common case,
   * and the one a theme author should not have to write down.
   */
  colorModes?: ThemeColorModes;
  /**
   * Lists of real content this theme wants, so it can draw a front page out of the
   * site's own posts and products instead of inventing them.
   *
   *   "collections": {
   *     "latest":   { "contentType": "post",    "limit": 6 },
   *     "featured": { "contentType": "product", "limit": 3 }
   *   }
   *
   * cms-api runs each query while it builds the page and puts the rows on
   * `ctx.collections` under the same names. A name whose content type does not exist
   * on this site resolves to an empty array rather than disappearing, so a template
   * can map over it without a guard — on a brand-new site, before anyone has written
   * anything.
   *
   * Declared, not queried: the theme says what it needs and core decides whether and
   * how to fetch it. A theme that could compose its own query would be a stranger's
   * code with a database attached.
   */
  collections?: Record<string, CollectionQuery>;
  /** Optional demo data an admin can seed for a site while this theme is active. */
  demo?: ThemeDemoData;
  /**
   * Capabilities the theme will use *if present* (e.g. "commerce.products").
   * Optional by design: a theme must degrade gracefully when the plugin that
   * provides a capability is not installed, so swapping plugins never forces a
   * theme rewrite.
   */
  optionalCapabilities?: string[];
  /** Runtime integration positions this theme deliberately exposes. */
  integrationSlots?: IntegrationSlot[];
}

/**
 * What a template receives. This is the theme's whole view of the world — if it
 * is not on here, the theme cannot reach it, which is what stops themes from
 * querying the database or calling internal APIs directly.
 */
export interface ThemeContext<S = Record<string, unknown>> {
  site: RenderPayload["site"];
  /** Typed theme settings, already merged with the manifest defaults. */
  settings: S;
  menus: Record<string, MenuDto | undefined>;
  /** The locale this page is being rendered in, e.g. "vi" or "en". */
  locale: string;
  /**
   * Translates a key from the *theme's own* catalogue — never core's. A theme
   * that ships no translation for the current locale falls back to its base
   * locale, then to the key itself, so a page always renders.
   */
  t: Translate;
  /** Renders a block document using the registry (core + theme + plugin blocks). */
  renderBlocks: (blocks: Block[]) => ReactNode;
  /** True when an active plugin provides the capability. */
  hasCapability: (capability: string) => boolean;
  /** Returns the public, allow-listed projection for an active capability. */
  getIntegration: <T = unknown>(capability: string) => RenderIntegration<T> | undefined;
  /** Renders runtime-owned interactive UI at a position chosen by the theme. */
  renderSlot: (slot: IntegrationSlot) => ReactNode;
  /** Absolute URL builder that respects the site's locale prefix. */
  url: (path: string) => string;
  /**
   * URL of a file the theme ships in its own package — its logo, its icons, a
   * background image:
   *
   *   <img src={ctx.asset("assets/logo.png")} />
   *
   * A theme cannot know where it was installed: it is fetched, verified and
   * unpacked under a key and a version it does not choose, and the *same* theme
   * is the built-in fallback compiled into the runtime, where no bundle exists at
   * all. So it names the file relative to its own package root and the runtime
   * says where that turned out to live.
   *
   * A path that is already absolute ("/uploads/x.png", "https://…") is returned
   * unchanged, which is what makes this safe to wrap around a *setting*: the
   * theme's shipped logo and an owner's uploaded one go through the same call.
   *
   *   ctx.asset(settings.logo || "assets/logo.png")
   */
  asset: (path: string) => string;
  /**
   * This page in every language it exists in — enough to draw a switcher:
   *
   *   ctx.alternates.map((a) => <a href={a.path} hrefLang={a.locale}>…</a>)
   *
   * The `path` of each entry is final. Do **not** pass it through `ctx.url()`:
   * that prefixes with the locale of the page being rendered, which for a link
   * pointing at a *different* language would produce "/vi/en/about".
   *
   * Only locales the page actually exists in appear, so a switcher built from
   * this can never link a reader to a 404. One entry (itself) on a monolingual
   * site, and none at all on a 404 — a theme that renders a switcher only when
   * `alternates.length > 1` needs no other guard.
   *
   * The display name is not sent: `Intl.DisplayNames` already knows it, in the
   * reader's own language, for every locale that exists.
   */
  alternates: LocaleAlternate[];
  /**
   * Dark and light: which modes this theme supports, and whether there is anything
   * to switch between. See ColorModeContext, and render the switch with
   * `<ColorModeToggle ctx={ctx} />`.
   *
   * It carries no *current* mode, on purpose — the server does not know it.
   */
  colorMode: ColorModeContext;
  /**
   * The lists this theme declared in `manifest.collections`, already fetched:
   *
   *   const latest = ctx.collections.latest ?? [];
   *
   *   {latest.map((post) => (
   *     <article key={post.id}>
   *       <a href={ctx.url(post.path)}>{post.title}</a>
   *       <p>{post.excerpt}</p>
   *     </article>
   *   ))}
   *
   * Real rows, in the locale being rendered, published only. At run time every name
   * the manifest declared is present — an empty array when there is nothing to show,
   * never missing — so a theme on a brand-new site renders an empty section rather
   * than crashing.
   *
   * The `?? []` is still worth writing, and the compiler will insist on it under
   * `noUncheckedIndexedAccess`. It is not defending against the runtime; it is
   * defending against a TYPO. `ctx.collections.lastest` is a name the manifest never
   * declared, and the honest value for it is nothing — the alternative is a crash on
   * a page that was only ever misspelt.
   *
   * An empty list is a normal state, and a theme should SAY so rather than leaving a
   * hole: a section that renders nothing at all is indistinguishable from a bug, and
   * the first person to see it will be the owner of a site with no posts yet.
   */
  collections: Record<string, ContentDto[]>;
}

export interface PageTemplateProps<S = Record<string, unknown>> {
  ctx: ThemeContext<S>;
  content: ContentDto;
}

export interface ArchiveTemplateProps<S = Record<string, unknown>> {
  ctx: ThemeContext<S>;
  archive: NonNullable<RenderPayload["archive"]>;
}

export interface NotFoundTemplateProps<S = Record<string, unknown>> {
  ctx: ThemeContext<S>;
}

export interface ErrorTemplateProps<S = Record<string, unknown>> {
  ctx: ThemeContext<S>;
  /**
   * The HTTP status the runtime is rendering for. Themes should treat this as
   * presentation input only: retry policy, logging and headers belong to core.
   */
  statusCode: number;
  /** Short, visitor-facing title. */
  title: string;
  /** Optional visitor-facing explanation. */
  message?: string;
  /** Opaque diagnostic id when the hosting/runtime provides one. */
  digest?: string;
}

export interface LayoutProps<S = Record<string, unknown>> {
  ctx: ThemeContext<S>;
  children: ReactNode;
}

/** Props a block component receives: its own props plus the theme context. */
export interface BlockProps<
  P = Record<string, unknown>,
  S = Record<string, unknown>,
> {
  block: Block;
  props: P;
  ctx: ThemeContext<S>;
}

/**
 * A block component, typed against BOTH its own props and its theme's settings.
 *
 * The settings parameter was missing at first, which pinned every block's `ctx`
 * to `ThemeContext<Record<string, unknown>>`: a template could read
 * `ctx.settings.accent`, a block could not — the same context object, typed two
 * different ways depending on where in the theme you stood.
 *
 * Writing a SECOND theme is what surfaced it. With one implementation in front
 * of you, no amount of staring at an SDK reveals which of its generics you
 * forgot to thread through; the first theme simply never asked the question.
 */
export type BlockComponent<
  P = Record<string, unknown>,
  S = Record<string, unknown>,
> = ComponentType<BlockProps<P, S>>;

export interface Theme<S = Record<string, unknown>> {
  manifest: ThemeManifest;
  /** Wraps every template: header, footer, global styles. */
  Layout: ComponentType<LayoutProps<S>>;
  templates: {
    home?: ComponentType<PageTemplateProps<S>>;
    /** The only required template — everything else falls back to it. */
    page: ComponentType<PageTemplateProps<S>>;
    post?: ComponentType<PageTemplateProps<S>>;
    archive?: ComponentType<ArchiveTemplateProps<S>>;
    search?: ComponentType<ArchiveTemplateProps<S>>;
    notFound?: ComponentType<NotFoundTemplateProps<S>>;
    error?: ComponentType<ErrorTemplateProps<S>>;
  };
  /**
   * How this theme draws each block type. A theme SHOULD cover every
   * CORE_BLOCK_TYPES entry; anything it omits falls back to the runtime's plain
   * renderer rather than breaking the page.
   */
  // `any` on both parameters, deliberately: component props are contravariant,
  // so pinning the map to the theme's settings type would reject every block
  // that declares its own props. A block opts INTO typing by writing
  // `BlockComponent<HeroProps, MySettings>`; the registry does not force it.
  blocks: Record<string, BlockComponent<any, any>>;

  /**
   * The theme's own translations, keyed by locale. `en` is the base every other
   * locale falls back to. Kept separate from the core catalogue so that adding a
   * language to a theme is a change to the theme, and nothing else.
   */
  messages?: ThemeMessageCatalog;

  /**
   * SEO derived from the site's settings, evaluated per render.
   *
   * `manifest.seo` is what the theme ships; this is what *this site* means. A
   * theme that exposes a "Favicon" or "Organisation name" setting maps it here,
   * and the value reaches the document head with no change to core.
   *
   * Optional: a theme that returns nothing simply keeps its manifest defaults.
   */
  seo?: (ctx: ThemeContext<S>) => ThemeSeoOverrides;
}
