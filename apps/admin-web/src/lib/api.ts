import { cookies } from "next/headers";
import { cache } from "react";
import type {
  AuthResult,
  CommerceSettingsDto,
  ContentDto,
  TranslationDto,
  ContentTypeDto,
  InvitationDto,
  LayoutDocument,
  MailSettingsDto,
  MediaDto,
  MediaFolderDto,
  MenuDto,
  OrderDto,
  OrderSummaryDto,
  Paginated,
  Permission,
  SessionUser,
  SiteDto,
  UserDto,
} from "@zcmsorg/schemas";
import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  SITE_COOKIE,
  accessCookieOptions,
  refreshCookieOptions,
} from "./cookies";
import { getLocale, getT } from "./locale";
import type { ThemeBlockSchema } from "./block-registry";
import type { ThemeSettingsSchema } from "./theme-schema";

export const API_URL = process.env.CMS_API_URL ?? "http://localhost:4100";
export const API_BASE = `${API_URL}/api/v1`;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/** The session is gone (or was never there). Callers redirect to /login. */
export class UnauthenticatedError extends ApiError {
  constructor(message: string) {
    super(401, message);
    this.name = "UnauthenticatedError";
  }
}

/** Authenticated, but the role does not carry the permission. */
export class ForbiddenError extends ApiError {
  constructor(message: string) {
    super(403, message);
    this.name = "ForbiddenError";
  }
}

/**
 * These messages reach a human — the error boundary renders them — so they are
 * translated at the throw site rather than carried as keys. A constructor cannot
 * await, which is why the lookup happens here and not in the class.
 */
async function sessionExpired(): Promise<UnauthenticatedError> {
  const t = await getT();
  return new UnauthenticatedError(t("auth.session.expired"));
}

function messageFromBody(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const m = (body as { message?: unknown }).message;
    if (typeof m === "string") return m;
    if (Array.isArray(m) && m.length > 0 && typeof m[0] === "string") {
      return m.join(", ");
    }
    const e = (body as { error?: unknown }).error;
    if (typeof e === "string") return e;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Token plumbing
// ---------------------------------------------------------------------------

async function readCookie(name: string): Promise<string | undefined> {
  const store = await cookies();
  return store.get(name)?.value;
}

/**
 * Writing cookies is only legal inside a Server Action or Route Handler. During
 * an RSC render Next throws, and there is nothing we can do about it — the
 * headers are already on their way out. In that case we still use the freshly
 * minted token for the in-flight request and let middleware persist a new pair
 * on the next navigation.
 */
async function tryPersistTokens(auth: AuthResult): Promise<void> {
  try {
    const store = await cookies();
    store.set(ACCESS_TOKEN_COOKIE, auth.accessToken, accessCookieOptions);
    store.set(REFRESH_TOKEN_COOKIE, auth.refreshToken, refreshCookieOptions);
  } catch {
    // RSC render context — ignore, see above.
  }
}

/** Memoised per request: a page with six parallel fetches must not fire six
 *  refreshes and invalidate five of them if the API rotates refresh tokens. */
const refreshOnce = cache(async (refreshToken: string): Promise<AuthResult | null> => {
  const res = await fetch(`${API_BASE}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
    cache: "no-store",
  });
  if (!res.ok) return null;
  return (await res.json()) as AuthResult;
});

// ---------------------------------------------------------------------------
// Core request
// ---------------------------------------------------------------------------

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** JSON body. Mutually exclusive with `formData`. */
  body?: unknown;
  formData?: FormData;
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Send `X-Site-Id`. Default true — most resources are site-scoped. */
  siteScoped?: boolean;
  /** Override the site id instead of reading the cookie. */
  siteId?: string;
  /** Skip the Authorization header (login/refresh only). */
  anonymous?: boolean;
  cache?: RequestCache;
}

function buildUrl(path: string, query: RequestOptions["query"]): string {
  const url = new URL(`${API_BASE}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function send(
  url: string,
  accessToken: string | undefined,
  siteId: string | undefined,
  locale: string,
  options: RequestOptions,
): Promise<Response> {
  const headers = new Headers();
  headers.set("Accept", "application/json");
  headers.set("Accept-Language", locale);
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  if (siteId) headers.set("X-Site-Id", siteId);

  let body: BodyInit | undefined;
  if (options.formData) {
    // Let fetch set the multipart boundary itself.
    body = options.formData;
  } else if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(options.body);
  }

  return fetch(url, {
    method: options.method ?? "GET",
    headers,
    body,
    cache: options.cache ?? "no-store",
  });
}

/**
 * The one place the admin talks to cms-api. Injects the bearer token and the
 * site header, retries exactly once behind a token refresh, and turns
 * non-2xx into typed errors.
 */
export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const url = buildUrl(path, options.query);
  const locale = await getLocale();

  const siteScoped = options.siteScoped ?? true;
  let siteId: string | undefined;
  if (siteScoped) {
    siteId = options.siteId ?? (await getCurrentSiteId()) ?? undefined;
  }

  let accessToken = options.anonymous ? undefined : await readCookie(ACCESS_TOKEN_COOKIE);
  let res = await send(url, accessToken, siteId, locale, options);

  if (res.status === 401 && !options.anonymous) {
    const refreshToken = await readCookie(REFRESH_TOKEN_COOKIE);
    if (!refreshToken) throw await sessionExpired();

    const refreshed = await refreshOnce(refreshToken);
    if (!refreshed) throw await sessionExpired();

    await tryPersistTokens(refreshed);
    accessToken = refreshed.accessToken;

    // A FormData body is a one-shot stream in some runtimes; it is safe here
    // because we hand fetch the same FormData object, which is re-readable.
    res = await send(url, accessToken, siteId, locale, options);
    if (res.status === 401) throw await sessionExpired();
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const parsed: unknown = text ? safeJson(text) : undefined;

  if (!res.ok) {
    const message = messageFromBody(parsed, `${res.status} ${res.statusText}`);
    if (res.status === 401) throw new UnauthenticatedError(message);
    if (res.status === 403) throw new ForbiddenError(message);
    throw new ApiError(res.status, message, parsed);
  }

  return parsed as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/** null when there is no usable session — callers decide whether to redirect. */
export const getSession = cache(async (): Promise<SessionUser | null> => {
  const token = await readCookie(ACCESS_TOKEN_COOKIE);
  const refresh = await readCookie(REFRESH_TOKEN_COOKIE);
  if (!token && !refresh) return null;

  try {
    // Site-scoped on purpose: the session's role and permissions are resolved for
    // the current site (X-Site-Id), so they include what a site-scoped plugin like
    // commerce grants. That is what lets `can(user, "order:read")` — and so the
    // Orders menu — be true only on a site where commerce is active. With no site
    // selected yet, the header is simply absent and the tenant baseline is returned.
    return await apiFetch<SessionUser>("/auth/me");
  } catch (error) {
    if (error instanceof UnauthenticatedError) return null;
    throw error;
  }
});

export function can(user: SessionUser | null, permission: Permission): boolean {
  return user?.permissions.includes(permission) ?? false;
}

export function canAny(user: SessionUser | null, permissions: Permission[]): boolean {
  return permissions.some((p) => can(user, p));
}

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

export const listSites = cache(
  async (): Promise<SiteDto[]> => apiFetch<SiteDto[]>("/sites", { siteScoped: false }),
);

/**
 * The active site id. Falls back to the first site the user can see when the
 * cookie is missing or points at a site that no longer exists, so a stale
 * cookie never bricks the admin.
 */
export const getCurrentSiteId = cache(async (): Promise<string | null> => {
  const fromCookie = await readCookie(SITE_COOKIE);
  if (fromCookie) return fromCookie;

  try {
    const sites = await listSites();
    return sites[0]?.id ?? null;
  } catch {
    return null;
  }
});

export const getCurrentSite = cache(async (): Promise<SiteDto | null> => {
  const sites = await listSites();
  if (sites.length === 0) return null;
  const id = await getCurrentSiteId();
  return sites.find((s) => s.id === id) ?? sites[0] ?? null;
});

// ---------------------------------------------------------------------------
// Users
//
// Not site-scoped: a person belongs to the tenant and may hold a different role
// on each site, so a list filtered to "the site you last clicked" would be a
// lie about who has access.
// ---------------------------------------------------------------------------

export const listUsers = cache(
  async (): Promise<UserDto[]> => apiFetch<UserDto[]>("/users", { siteScoped: false }),
);

export const listInvitations = cache(
  async (): Promise<InvitationDto[]> =>
    apiFetch<InvitationDto[]>("/users/invitations", { siteScoped: false }),
);

// ---------------------------------------------------------------------------
// Content types
// ---------------------------------------------------------------------------

export const listContentTypes = cache(
  async (): Promise<ContentTypeDto[]> => apiFetch<ContentTypeDto[]>("/content-types"),
);

export const getContentTypeByKey = cache(async (key: string): Promise<ContentTypeDto | null> => {
  const types = await listContentTypes();
  return types.find((t) => t.key === key) ?? null;
});

// ---------------------------------------------------------------------------
// Contents
// ---------------------------------------------------------------------------

export interface ContentListQuery {
  contentTypeKey?: string;
  status?: string;
  locale?: string;
  page?: number;
  perPage?: number;
  search?: string;
}

export async function listContents(query: ContentListQuery): Promise<Paginated<ContentDto>> {
  return apiFetch<Paginated<ContentDto>>("/contents", { query: { ...query } });
}

/**
 * Resolve the Theme Editor's collection bindings into REAL rows for the current
 * site, so the canvas draws with the site's own content instead of placeholders.
 * Keyed by the deterministic collection name the editor derives from each binding.
 */
export async function previewCollections(
  body: import("@zcmsorg/schemas").PreviewCollectionsRequest,
): Promise<Record<string, ContentDto[]>> {
  return apiFetch<Record<string, ContentDto[]>>("/render/preview-collections", {
    method: "POST",
    body,
  });
}

export async function getContent(id: string): Promise<ContentDto> {
  return apiFetch<ContentDto>(`/contents/${id}`);
}

/**
 * One row per locale the site publishes in, translated or not.
 *
 * Never throws into the page: a site with one language has nothing to show here,
 * and neither does a request that failed. The translations panel is an aid, not
 * the reason the editor exists — it must not be able to take the editor down.
 */
export async function getContentTranslations(id: string): Promise<TranslationDto[]> {
  try {
    return await apiFetch<TranslationDto[]>(`/contents/${id}/translations`);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

export interface MediaListQuery {
  page?: number;
  perPage?: number;
  search?: string;
  kind?: "image" | "document";
  /**
   * A folder id, or "root" for the top level. Undefined searches across the whole
   * library — which is what a search must do, or it would report "no results"
   * about a file sitting one folder away.
   */
  folder?: string;
}

export async function listMedia(query: MediaListQuery = {}): Promise<Paginated<MediaDto>> {
  const { page = 1, perPage = 24, search, kind, folder } = query;
  return apiFetch<Paginated<MediaDto>>("/media", {
    query: { page, perPage, search, kind, folder },
  });
}

export async function listMediaFolders(): Promise<MediaFolderDto[]> {
  return apiFetch<MediaFolderDto[]>("/media/folders");
}

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

/** BUILTIN/MARKETPLACE render as "verified"; SIDELOAD as "unverified" (operator's own). */
export type PackageOrigin = "BUILTIN" | "MARKETPLACE" | "SIDELOAD";

export interface InstalledThemeDto {
  key: string;
  name: string;
  version: string;
  status: string;
  origin: PackageOrigin;
  /** A sideload is QUARANTINED until the operator approves it; APPROVED ones render. */
  reviewStatus: string;
  settings: Record<string, unknown>;
  settingsSchema: ThemeSettingsSchema | null;
  /**
   * The theme's block-editing schemas, keyed by block type ("zsoft/hero"). The
   * content editor builds a form for the theme's own blocks from this; `{}` when
   * the theme ships none, in which case those blocks get the generic fallback
   * editor. Mirrors `settingsSchema`: shipped by the theme, not coded into admin.
   */
  editorBlocks: Record<string, ThemeBlockSchema>;
  demoAvailable: boolean;
  demoSeeded: boolean;
  screenshots: string[];
  /**
   * Release notes for the installed version as a locale → notes map (English always
   * present), or null if the theme shipped none. Resolved to the reader's language
   * by `ChangelogNote`.
   */
  changelog: Record<string, string> | null;
}

export interface ThemeCatalogEntry {
  key: string;
  name: string;
  description: string;
  author: string;
  screenshots: string[];
  versions: {
    version: string;
    origin: PackageOrigin;
    reviewStatus: string;
    /** Locale → notes map (English always present), or null if none shipped. */
    changelog: Record<string, string> | null;
  }[];
}

export const listInstalledThemes = cache(
  async (): Promise<InstalledThemeDto[]> => apiFetch<InstalledThemeDto[]>("/themes/installed"),
);

/**
 * The active theme's block-editing schemas, so the content editor can offer a form
 * for the theme's own blocks (`zsoft/hero`, …) instead of a read-only JSON dump.
 * `{}` when no theme is active or it declares none. Shares the cached
 * `listInstalledThemes` request the theme screens already make.
 */
export const getActiveThemeEditorBlocks = cache(
  async (): Promise<Record<string, ThemeBlockSchema>> => {
    // Block schemas only make the editor nicer; they are not required to edit. A
    // content editor may lack `theme:read` (so `/themes/installed` 403s), or a site
    // may have no active theme — either way the editor must still open, with core
    // blocks and the generic fallback. So this never throws: it degrades to `{}`.
    try {
      const themes = await listInstalledThemes();
      const active = themes.find((theme) => theme.status === "ACTIVE");
      return active?.editorBlocks ?? {};
    } catch {
      return {};
    }
  },
);

export const listThemeCatalog = cache(
  async (): Promise<ThemeCatalogEntry[]> =>
    apiFetch<ThemeCatalogEntry[]>("/themes", { siteScoped: false }),
);

// ---------------------------------------------------------------------------
// Theme drafts (the GUI Theme Editor's documents)
// ---------------------------------------------------------------------------

export type ThemeDraftStatus = "DRAFT" | "BUILDING" | "BUILT" | "SUBMITTED" | "FAILED";

export interface ThemeDraftSummaryDto {
  id: string;
  siteId: string;
  name: string;
  key: string;
  version: string;
  description: string | null;
  status: ThemeDraftStatus;
  buildError: string | null;
  lastBuiltAt: string | null;
  submittedAt: string | null;
  author: { id: string; name: string } | null;
  updatedAt: string;
}

export interface ThemeDraftDto extends ThemeDraftSummaryDto {
  document: LayoutDocument;
  /**
   * This version's release notes as a locale → notes map (English present when set),
   * or null. Edited in the theme editor and fed into the build so it lands in the
   * signed theme.json.
   */
  changelog: Record<string, string> | null;
  submissionRef: string | null;
  /** The digest the author signs. Null until a build stages one. */
  payloadChecksum: string | null;
  createdAt: string;
}

/**
 * The site's menus, as the editor's canvas needs them: a `layout/menu` widget names
 * a LOCATION, and the preview can only draw it if it knows what is assigned there.
 */
export const listMenus = cache(async (): Promise<MenuDto[]> => apiFetch<MenuDto[]>("/menus"));

/** The list screen's rows. Deliberately without documents — see the API's DTO note. */
export const listThemeDrafts = cache(
  async (): Promise<ThemeDraftSummaryDto[]> => apiFetch<ThemeDraftSummaryDto[]>("/theme-drafts"),
);

export const getThemeDraft = cache(
  async (id: string): Promise<ThemeDraftDto> =>
    apiFetch<ThemeDraftDto>(`/theme-drafts/${encodeURIComponent(id)}`),
);

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

/**
 * One row of GET /plugins: the catalog entry plus this site's install state.
 *
 * `permissions` is what the plugin's manifest ASKS for; it is never what was
 * granted. `grantedPermissions` and `settings` are only meaningful when
 * `installed` — and the API does not always send them back (see the plugins
 * page), so both are optional and the UI must not assume them.
 */
export interface CatalogPluginDto {
  key: string;
  name: string;
  description: string | null;
  publisher: string;
  isCore: boolean;
  /** Activation reach: per-site or tenant-wide. */
  scope: "SITE" | "ORG";
  /** Derived admin-facing tier: PLATFORM (core), ORG (tenant-wide), or SITE. */
  tier: "PLATFORM" | "ORG" | "SITE";
  /** True when this plugin is active org-wide — it runs here but is managed on the org screen. */
  orgActive: boolean;
  latestVersion: string | null;
  /** Origin of the latest version — SIDELOAD means the operator installed it from a file. */
  origin?: PackageOrigin | null;
  /** A sideload is QUARANTINED until the operator approves it. */
  reviewStatus?: string | null;
  permissions: Permission[];
  capabilities: string[];
  /** The hosts the manifest declared. What `network:fetch` actually grants. */
  networkHosts?: string[];
  settingsSchema: ThemeSettingsSchema | null;
  installed: boolean;
  status: string | null;
  grantedPermissions?: Permission[] | null;
  settings?: Record<string, unknown> | null;
  /**
   * The latest version's release notes as a locale → notes map (English always
   * present), or null if the plugin shipped none. Resolved to the reader's language
   * by `ChangelogNote`.
   */
  changelog?: Record<string, string> | null;
}

export const listPlugins = cache(
  async (): Promise<CatalogPluginDto[]> => apiFetch<CatalogPluginDto[]>("/plugins"),
);

/** The organization-wide plugin catalog (ORG-scoped plugins only). */
export const listOrgPlugins = cache(
  async (): Promise<CatalogPluginDto[]> => apiFetch<CatalogPluginDto[]>("/org/plugins"),
);

// ---------------------------------------------------------------------------
// Plugin admin screens — the list/detail/form a plugin declares and core renders.
// Types mirror the plugin-sdk shapes; admin-web reads them off the wire rather
// than importing the SDK, which is a build-time dependency it does not need.
// ---------------------------------------------------------------------------

export interface PluginNavContribution {
  pluginKey: string;
  label: string;
  icon?: string;
  resource: string;
  permission: string;
}

export interface PluginResourceColumn {
  column: string;
  label: string;
}

export interface PluginResourceField {
  column: string;
  label: string;
  input?:
    | "text"
    | "textarea"
    | "richtext"
    | "number"
    | "boolean"
    | "select"
    | "date"
    | "media"
    | "reference";
  /** Server-normalized: `value` is stored, `label` is display-only. */
  options?: Array<{ value: string; label: string }>;
  refTable?: string;
  readonly?: boolean;
}

export interface PluginResourceDescriptor {
  key: string;
  label: string;
  table: string;
  list: {
    columns: PluginResourceColumn[];
    orderBy?: { column: string; direction?: "asc" | "desc" };
  };
  form?: { fields: PluginResourceField[] };
  permissions: { read: string; write?: string };
}

export interface PluginAdminContributions {
  nav: PluginNavContribution[];
  resources: Array<{ pluginKey: string; resource: PluginResourceDescriptor }>;
}

/** The plugin admin screens the current user may see on the current site. */
export const getPluginAdminContributions = cache(
  async (): Promise<PluginAdminContributions> =>
    apiFetch<PluginAdminContributions>("/plugin-admin/contributions"),
);

export type PluginRow = Record<string, unknown>;

export async function listPluginResource(
  pluginKey: string,
  resourceKey: string,
  query: { page?: number; perPage?: number } = {},
): Promise<{ resource: PluginResourceDescriptor; rows: PluginRow[] }> {
  return apiFetch(
    `/plugin-admin/${encodeURIComponent(pluginKey)}/${encodeURIComponent(resourceKey)}`,
    { query: { page: query.page, perPage: query.perPage } },
  );
}

export async function createPluginRow(
  pluginKey: string,
  resourceKey: string,
  row: PluginRow,
): Promise<{ row: PluginRow | null }> {
  return apiFetch(
    `/plugin-admin/${encodeURIComponent(pluginKey)}/${encodeURIComponent(resourceKey)}`,
    { method: "POST", body: row },
  );
}

export async function updatePluginRow(
  pluginKey: string,
  resourceKey: string,
  id: string,
  patch: PluginRow,
): Promise<{ rows: PluginRow[] }> {
  return apiFetch(
    `/plugin-admin/${encodeURIComponent(pluginKey)}/${encodeURIComponent(resourceKey)}/${encodeURIComponent(id)}`,
    { method: "PATCH", body: patch },
  );
}

export async function deletePluginRow(
  pluginKey: string,
  resourceKey: string,
  id: string,
): Promise<{ deleted: number }> {
  return apiFetch(
    `/plugin-admin/${encodeURIComponent(pluginKey)}/${encodeURIComponent(resourceKey)}/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
}

// ---------------------------------------------------------------------------
// Marketplace package primitives
// ---------------------------------------------------------------------------

export type PackageKind = "theme" | "plugin";

// ---------------------------------------------------------------------------
// Marketplace — the site owner's side (browse + install). This is the
// catalogue you install FROM.
// ---------------------------------------------------------------------------

/** Who published a listing, as the marketplace knows them. Displayed, never imported. */
export interface MarketplacePublisherRef {
  slug: string;
  name: string;
  verified: boolean;
}

/**
 * One listing in the marketplace, annotated with what this instance already has.
 *
 * `installed` / `installedVersion` are why a browse endpoint exists at all rather
 * than a raw catalogue: the interesting states are "not installed", "installed
 * and current", and "installed but the marketplace has moved on" — and only the
 * consumer can compute them, because only it knows what it holds.
 */
export interface BrowsePackageDto {
  kind: PackageKind;
  key: string;
  name: string;
  description: string | null;
  author: string;
  publisher: MarketplacePublisherRef | null;
  latestVersion: string;
  versions: string[];
  /** What the newest version's manifest requests. A plugin's real price, shown before install. */
  permissions: Permission[];
  /**
   * Up to three screenshots of the newest version, as absolute URLs on the
   * marketplace. cms-api has already joined them onto MARKETPLACE_URL, so nothing
   * here has to know they arrive from the registry as relative paths.
   *
   * They live inside the signed package, so a screenshot cannot be swapped without
   * breaking the publisher's signature.
   */
  screenshots: string[];
  /** External video URL (YouTube, Vimeo, …), or null. Never a file in the package. */
  video: string | null;
  updatedAt: string;
  installed: boolean;
  installedVersion: string | null;
}

/**
 * Where this instance shops, and how fresh its safety data is.
 *
 * `stale` is the field that matters, and it is a security signal, not a
 * diagnostic. Revocation sync is fail-open — an instance that cannot reach the
 * marketplace keeps running what it has — so "we have not heard from the
 * marketplace in a day" is the difference between a kill switch that works and
 * one that only appears to. The screen surfaces it; it does not bury it.
 */
export interface MarketplaceStatusDto {
  url: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  revokedCount: number;
  stale: boolean;
}

export const browseMarketplace = cache(
  async (kind?: PackageKind, q?: string): Promise<BrowsePackageDto[]> =>
    apiFetch<BrowsePackageDto[]>("/marketplace/browse", {
      query: { kind, q },
      siteScoped: false,
    }),
);

export const getMarketplaceStatus = cache(
  async (): Promise<MarketplaceStatusDto> =>
    apiFetch<MarketplaceStatusDto>("/marketplace/status", { siteScoped: false }),
);

// ---------------------------------------------------------------------------
// Background jobs (dead-letter queue)
// ---------------------------------------------------------------------------

export interface FailedJobDto {
  id: string;
  name: string;
  attemptsMade: number;
  failedReason: string | null;
  /** Null when BullMQ has no finish timestamp for the job (rare, but real). */
  failedAt: string | null;
  data: unknown;
}

/**
 * A page of the dead-letter queue, and `total` — the size of the whole queue.
 *
 * The total is not decoration. Showing 50 rows out of 1,204 without saying so
 * would let an operator retry everything they can see and conclude the queue is
 * empty.
 */
export interface FailedJobPageDto {
  items: FailedJobDto[];
  total: number;
}

export async function listFailedJobs(limit = 50): Promise<FailedJobPageDto> {
  return apiFetch<FailedJobPageDto>("/jobs/failed", { query: { limit } });
}

/** Empties the dead-letter queue, returning how many jobs were removed. */
export async function clearFailedJobs(): Promise<{ cleared: number }> {
  return apiFetch<{ cleared: number }>("/jobs/failed", { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Commerce
// ---------------------------------------------------------------------------

export interface OrderListQuery {
  status?: string;
  q?: string;
  page?: number;
  perPage?: number;
}

/** The shop's orders, newest first. Site-scoped, so `X-Site-Id` travels with it. */
export async function listOrders(query: OrderListQuery): Promise<Paginated<OrderSummaryDto>> {
  return apiFetch<Paginated<OrderSummaryDto>>("/orders", { query: { ...query } });
}

export async function getOrder(id: string): Promise<OrderDto> {
  return apiFetch<OrderDto>(`/orders/${id}`);
}

/** The storefront configuration: currency, shipping, payment methods. */
export const getCommerceSettings = cache(
  async (): Promise<CommerceSettingsDto> => apiFetch<CommerceSettingsDto>("/settings/commerce"),
);

// ---------------------------------------------------------------------------
// Mail
// ---------------------------------------------------------------------------

/**
 * The site's SMTP configuration. The password is not in it — see MailSettingsDto,
 * which has a `hasPassword` boolean and no field the secret could hide in.
 */
export const getMailSettings = cache(
  async (): Promise<MailSettingsDto> => apiFetch<MailSettingsDto>("/settings/mail"),
);
