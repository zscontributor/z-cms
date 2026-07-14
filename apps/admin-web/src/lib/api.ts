import { cookies } from "next/headers";
import { cache } from "react";
import type {
  AuthResult,
  ContentDto,
  TranslationDto,
  ContentTypeDto,
  InvitationDto,
  MailSettingsDto,
  MediaDto,
  MediaFolderDto,
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
import { getT } from "./locale";
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
  options: RequestOptions,
): Promise<Response> {
  const headers = new Headers();
  headers.set("Accept", "application/json");
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

  const siteScoped = options.siteScoped ?? true;
  let siteId: string | undefined;
  if (siteScoped) {
    siteId = options.siteId ?? (await getCurrentSiteId()) ?? undefined;
  }

  let accessToken = options.anonymous ? undefined : await readCookie(ACCESS_TOKEN_COOKIE);
  let res = await send(url, accessToken, siteId, options);

  if (res.status === 401 && !options.anonymous) {
    const refreshToken = await readCookie(REFRESH_TOKEN_COOKIE);
    if (!refreshToken) throw await sessionExpired();

    const refreshed = await refreshOnce(refreshToken);
    if (!refreshed) throw await sessionExpired();

    await tryPersistTokens(refreshed);
    accessToken = refreshed.accessToken;

    // A FormData body is a one-shot stream in some runtimes; it is safe here
    // because we hand fetch the same FormData object, which is re-readable.
    res = await send(url, accessToken, siteId, options);
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
    return await apiFetch<SessionUser>("/auth/me", { siteScoped: false });
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
  page?: number;
  perPage?: number;
  search?: string;
}

export async function listContents(query: ContentListQuery): Promise<Paginated<ContentDto>> {
  return apiFetch<Paginated<ContentDto>>("/contents", { query: { ...query } });
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
  demoAvailable: boolean;
  demoSeeded: boolean;
}

export interface ThemeCatalogEntry {
  key: string;
  name: string;
  description: string;
  author: string;
  versions: { version: string; origin: PackageOrigin; reviewStatus: string }[];
}

export const listInstalledThemes = cache(
  async (): Promise<InstalledThemeDto[]> => apiFetch<InstalledThemeDto[]>("/themes/installed"),
);

export const listThemeCatalog = cache(
  async (): Promise<ThemeCatalogEntry[]> =>
    apiFetch<ThemeCatalogEntry[]>("/themes", { siteScoped: false }),
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
}

export const listPlugins = cache(
  async (): Promise<CatalogPluginDto[]> => apiFetch<CatalogPluginDto[]>("/plugins"),
);

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
