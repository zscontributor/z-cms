import { z } from "zod";
import { BlockDocumentSchema } from "./blocks";
import {
  ContentStatusSchema,
  ContentTypeFieldSchema,
  SeoSchema,
  isBrowserSafeUrl,
} from "./content";
import { RoleSchema, PermissionSchema, type Role } from "./permissions";

/**
 * The wire contract between cms-api and its two front ends.
 *
 * admin-web and site-runtime import these types instead of redeclaring their
 * own, so a change to a response shape breaks the build rather than the site.
 */

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const LoginSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof LoginSchema>;

export const SessionUserSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  name: z.string(),
  avatarUrl: z.string().nullable(),
  tenantId: z.uuid(),
  tenantSlug: z.string(),
  role: RoleSchema,
  permissions: z.array(PermissionSchema),
  /** Whether this account is protected by a second factor. Drives the profile screen. */
  twoFactorEnabled: z.boolean(),
});
export type SessionUser = z.infer<typeof SessionUserSchema>;

export const AuthResultSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  user: SessionUserSchema,
});
export type AuthResult = z.infer<typeof AuthResultSchema>;

// ---------------------------------------------------------------------------
// Two-factor authentication (TOTP)
// ---------------------------------------------------------------------------

/**
 * What `POST /auth/login` answers with when the password was right but the
 * account has a second factor: no tokens, only a short-lived ticket saying
 * "come back with a code".
 *
 * The ticket is a JWT signed with a *different* key than access and refresh
 * tokens, so it cannot be presented as either. It proves exactly one thing —
 * that this password was checked, recently — and it buys exactly one thing: the
 * right to attempt a code. Nothing else in the API accepts it.
 */
export const MfaChallengeSchema = z.object({
  mfaRequired: z.literal(true),
  challengeToken: z.string(),
  /** Seconds until the ticket dies and the password must be entered again. */
  expiresIn: z.number().int(),
});
export type MfaChallenge = z.infer<typeof MfaChallengeSchema>;

/**
 * Login now has two possible shapes. A caller must branch on `mfaRequired`
 * rather than assuming tokens — which is exactly why it is a discriminant and
 * not an absent field.
 */
export type LoginResult = AuthResult | MfaChallenge;

export function isMfaChallenge(result: LoginResult): result is MfaChallenge {
  return (result as MfaChallenge).mfaRequired === true;
}

/** Six digits, and only six digits — a string, because "012345" is not 12345. */
export const TOTP_CODE_LENGTH = 6;
const TotpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, "A code is six digits.");

/**
 * A recovery code, in the shape it is shown: two groups of five, hyphenated.
 *
 * Accepted case-insensitively and with the hyphen optional, because it is typed
 * by a person who has just lost their phone and is having a bad enough day.
 */
export const RECOVERY_CODE_COUNT = 10;
const RecoveryCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9]{5}-?[A-Za-z0-9]{5}$/, "That is not a recovery code.");

/**
 * The second step of login: either the code from the authenticator, or one of
 * the recovery codes, in the same field.
 *
 * One field, not two, and deliberately: a person reaching for a recovery code is
 * a person whose phone is gone, and making them first find the right tab for it
 * serves nobody. The server tells the two apart by shape.
 */
export const MfaVerifySchema = z.object({
  challengeToken: z.string().min(1),
  code: z.union([TotpCodeSchema, RecoveryCodeSchema]),
});
export type MfaVerifyInput = z.infer<typeof MfaVerifySchema>;

/**
 * What enrollment hands back. `secret` is shown so it can be typed by hand when
 * a camera is not an option; `otpauthUrl` is what the QR encodes.
 *
 * Enrollment does NOT switch 2FA on. The secret sits pending until a code proves
 * the authenticator actually holds it — otherwise a mistyped setup locks the user
 * out of their own account, with a "protection" they cannot pass.
 */
export interface TotpSetupDto {
  secret: string;
  otpauthUrl: string;
}

export const EnableTotpSchema = z.object({ code: TotpCodeSchema });
export type EnableTotpInput = z.infer<typeof EnableTotpSchema>;

/**
 * Turning 2FA OFF takes the password, not just a code.
 *
 * The code alone would mean an unlocked laptop is enough to strip the protection
 * that exists precisely because a password can leak. Both, or neither.
 */
export const DisableTotpSchema = z.object({
  password: z.string().min(1),
  code: z.union([TotpCodeSchema, RecoveryCodeSchema]),
});
export type DisableTotpInput = z.infer<typeof DisableTotpSchema>;

/** Reissuing recovery codes invalidates the old ones, so it takes the password. */
export const RegenerateRecoveryCodesSchema = z.object({ password: z.string().min(1) });
export type RegenerateRecoveryCodesInput = z.infer<typeof RegenerateRecoveryCodesSchema>;

/**
 * The recovery codes, in the clear. Like the invite token, this is the only
 * moment they exist in readable form — only their hashes are stored — so the
 * screen showing them has to say so.
 */
export interface RecoveryCodesDto {
  recoveryCodes: string[];
}

/** Claims carried in the access token. Kept minimal — no permissions inside. */
export interface AccessTokenClaims {
  sub: string;
  tid: string;
  email: string;
  /**
   * The session (refresh-token rotation family) this access token belongs to.
   *
   * An access token is a stateless JWT, so revoking a session could not reach one
   * already in flight — a logged-out user stayed logged in for up to the access
   * TTL. Carrying the family id makes revocation checkable: the API keeps a short
   * denylist of revoked families and refuses any token naming one.
   */
  fid: string;
}

// ---------------------------------------------------------------------------
// Users, memberships and invitations
// ---------------------------------------------------------------------------

/**
 * A length floor and nothing else.
 *
 * No "one uppercase, one digit, one symbol" rule: those push people towards
 * `Passw0rd!` — which satisfies every box and is on every wordlist — and away
 * from a long passphrase, which is what actually resists guessing. Length is the
 * only lever that reliably buys entropy, so it is the only one enforced. The
 * ceiling exists so a megabyte password cannot turn bcrypt into a denial of
 * service.
 */
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 200;
export const PasswordSchema = z.string().min(PASSWORD_MIN).max(PASSWORD_MAX);

/**
 * `siteId: null` means the role applies to every site in the tenant — it is not
 * "unset". The two must stay distinguishable, which is why this is nullable
 * rather than optional: a body that omits the key is asking for the tenant-wide
 * role, and saying so out loud is cheaper than guessing.
 */
const MembershipScopeSchema = z
  .uuid()
  .nullable()
  .default(null)
  .describe("The site this role applies to. Null grants it across the whole tenant.");

export const InviteUserSchema = z.object({
  email: z.email(),
  role: RoleSchema,
  siteId: MembershipScopeSchema,
});
export type InviteUserInput = z.infer<typeof InviteUserSchema>;

/**
 * Accepting an invitation is where the account is actually created: the invite
 * carries the email and the role, the invitee supplies the name and the password.
 * The token is single-use and only its hash is stored, like a refresh token.
 */
export const AcceptInviteSchema = z.object({
  token: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  password: PasswordSchema,
});
export type AcceptInviteInput = z.infer<typeof AcceptInviteSchema>;

export const SetMembershipSchema = z.object({
  role: RoleSchema,
  siteId: MembershipScopeSchema,
});
export type SetMembershipInput = z.infer<typeof SetMembershipSchema>;

export const UpdateProfileSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    // z.url() checks syntax; the refine rejects a `javascript:`/`data:` scheme,
    // which is valid URL syntax but a script sink once rendered into an <img src>.
    avatarUrl: z
      .url()
      .refine(isBrowserSafeUrl, { message: "Avatar URL must use http or https." })
      .nullable(),
  })
  .partial();
export type UpdateProfileInput = z.infer<typeof UpdateProfileSchema>;

/**
 * The current password is required even though the caller is already
 * authenticated. It is the difference between "someone who is signed in" and
 * "the account's owner" — an unattended laptop is the whole reason this check
 * exists.
 */
export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: PasswordSchema,
});
export type ChangePasswordInput = z.infer<typeof ChangePasswordSchema>;

/** One role a user holds, and where. `siteId: null` is tenant-wide. */
export interface MembershipDto {
  id: string;
  role: Role;
  siteId: string | null;
  /** Null for a tenant-wide membership — there is no one site to name. */
  siteName: string | null;
}

export interface UserDto {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  /** Null until they have signed in once — which is how a dormant account shows. */
  lastLoginAt: string | null;
  /**
   * Visible to anyone with `user:read`, and not a privacy leak: whether a
   * colleague's account is protected by a second factor is exactly what an
   * administrator is accountable for knowing. It is the column that turns "we
   * have 2FA" into "everyone is actually using it".
   */
  twoFactorEnabled: boolean;
  createdAt: string;
  memberships: MembershipDto[];
}

export interface InvitationDto {
  id: string;
  email: string;
  role: Role;
  siteId: string | null;
  siteName: string | null;
  /** The name of whoever sent it. Null if that account has since been removed. */
  invitedByName: string | null;
  expiresAt: string;
  createdAt: string;
}

/**
 * The one response that carries the raw invite token.
 *
 * Z-CMS has no mailer, so the link is handed back to whoever created the
 * invitation to deliver themselves. Only the token's SHA-256 is stored, which
 * means this is the *only* moment it exists in readable form: there is no
 * "show me that link again" endpoint, and reissuing means revoking and inviting
 * afresh. The UI has to say so.
 */
export interface InvitationCreatedDto {
  invitation: InvitationDto;
  token: string;
}

// ---------------------------------------------------------------------------
// Hostnames
// ---------------------------------------------------------------------------

/**
 * Turns whatever a human pasted into the bare hostname the resolver matches on.
 *
 * A site is resolved by the `Host` header verbatim — "z-cms.org", or
 * "localhost:3100" in development — so the stored value is a hostname, never a
 * URL. But the field is *described* to people as the address of their site, and
 * the address of a site is a thing they have in their address bar. They paste
 * "https://z-cms.org/". Rejecting that is technically correct and useless: the
 * intent is unambiguous, so honour it instead of arguing with it.
 *
 * Strips the scheme, anything from the first "/" on, and a trailing dot (the
 * root label — "z-cms.org." and "z-cms.org" are the same host, but only one of
 * them matches a row).
 */
export function normalizeHostname(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\.$/, "");
}

/** The shape `normalizeHostname` produces, and the only shape the resolver can match. */
export const HOSTNAME_RE =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;

/**
 * The other spelling of the same site: "z-cms.org" <-> "www.z-cms.org".
 *
 * People do not distinguish these, so neither does the resolver: whichever of the
 * two a site was created with, the other one finds it — and is then redirected to
 * it, so the page still has exactly one URL. Returns null when the host has no
 * other spelling, which is the case that matters in development: "localhost:3100"
 * has no dot, and "www.localhost:3100" is not a thing anyone will ever type.
 */
export function wwwVariant(hostname: string): string | null {
  if (hostname.startsWith("www.")) return hostname.slice(4);
  // A single label ("localhost", with or without a port) is not a domain that can
  // carry a www — only something with a dot in it is.
  const host = hostname.split(":")[0] ?? "";
  if (!host.includes(".")) return null;
  return `www.${hostname}`;
}

/** A host and both of its spellings, most-specific first. */
export function hostnameVariants(hostname: string): string[] {
  const other = wwwVariant(hostname);
  return other ? [hostname, other] : [hostname];
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export const PaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
});

export interface Paginated<T> {
  items: T[];
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

/**
 * Screenshots and a preview video, as a theme or plugin DECLARES them in its
 * theme.json / plugin.json.
 *
 * The rules are enforced by @zcmsorg/package (which is what packs and what the
 * marketplace runs on publish), not here — this is only the shape an author
 * writes. In brief, and they are refusals rather than warnings:
 *
 *   - at most 3 screenshots;
 *   - each at most 2 MB, and at most 4096px on a side;
 *   - .png / .jpg / .webp only. **No SVG** — an SVG can carry script and it is
 *     served to a browser from the admin's own origin;
 *   - the video is an external https URL, never a file in the package. A packaged
 *     video would dwarf the code, and every install would pay to download it.
 *
 * The images live INSIDE the signed package, so the publisher's signature and the
 * marketplace's counter-signature cover them exactly as they cover the code: a
 * screenshot cannot be swapped without breaking a signature.
 */
export interface PackageMediaDeclaration {
  /** Paths inside the package, e.g. ["screenshots/home.png"]. At most three. */
  screenshots?: string[];
  /** An https URL to YouTube, Vimeo, or anywhere else that already does video. */
  video?: string;
}

/**
 * Screenshots as the ADMIN receives them: absolute URLs it can put in an <img>,
 * already resolved against wherever they are served from.
 */
export interface PackageMedia {
  screenshots: string[];
  video: string | null;
}

/**
 * A site's identity, independent of whichever theme is drawing it.
 *
 * Colour and logo belong to the SITE, not to the theme. A theme is a way of
 * presenting a site; swapping one for another must not lose the customer their
 * brand, which is exactly what happens when the only place to set a logo is a
 * theme's own settings. So it lives here, reaches every theme through
 * `ctx.site.brand`, and a theme may put it wherever it likes — header, footer,
 * a loading spinner, nowhere at all.
 *
 * A theme MAY still expose its own colour/logo settings; those are a per-theme
 * override, and when left empty the site's brand shows through.
 *
 * Empty strings, not nulls: a theme reads `brand.logo || somethingElse`, and the
 * one thing that must never happen is a template rendering the word "null".
 */
export interface SiteBrand {
  /** Accent colour as hex, e.g. "#FA5600". Always set; the platform has a default. */
  primaryColor: string;
  /** URL of the site's logo. Empty when the owner has not set one. */
  logo: string;
}

/** What the platform gives a site whose owner has set no brand of their own. */
export const DEFAULT_SITE_BRAND: SiteBrand = {
  primaryColor: "#FA5600",
  logo: "",
};

/**
 * The brand as it may be WRITTEN. Strict: a colour that is not a colour is a
 * rejected request, not a broken stylesheet on every page of the site.
 */
export const SiteBrandSchema = z.object({
  primaryColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "A six-digit hex colour, e.g. #FA5600.")
    .default(DEFAULT_SITE_BRAND.primaryColor),
  logo: z
    .string()
    .max(2048)
    .default("")
    .describe("URL of the logo. Usually a media URL; empty means none."),
});

/**
 * The brand as it is READ back out of `Site.settings`, which is a JSON column and
 * therefore holds whatever was true the day it was written.
 *
 * Deliberately tolerant where `SiteBrandSchema` is strict. A row written by an
 * older version — or by hand — must still render a site, so anything unreadable
 * falls back to the platform default field by field rather than throwing. The
 * strict schema guards the door; this one has to cope with what is already inside.
 */
export function parseSiteBrand(settings: unknown): SiteBrand {
  const raw = (settings as { brand?: unknown } | null | undefined)?.brand;
  const brand = (raw ?? {}) as Partial<Record<keyof SiteBrand, unknown>>;

  const primaryColor =
    typeof brand.primaryColor === "string" && /^#[0-9a-fA-F]{6}$/.test(brand.primaryColor)
      ? brand.primaryColor
      : DEFAULT_SITE_BRAND.primaryColor;

  const logo = typeof brand.logo === "string" ? brand.logo : DEFAULT_SITE_BRAND.logo;

  return { primaryColor, logo };
}

export interface SiteDto {
  id: string;
  slug: string;
  name: string;
  status: "DRAFT" | "PUBLISHED" | "SUSPENDED" | "ARCHIVED";
  defaultLocale: string;
  locales: string[];
  brand: SiteBrand;
  domains: { id: string; hostname: string; isPrimary: boolean }[];
  activeTheme: { key: string; name: string; version: string } | null;
}

export type ContentTypeDto = {
  id: string;
  key: string;
  name: string;
  pluralName: string;
  description: string | null;
  isSingleton: boolean;
  isRoutable: boolean;
  routePrefix: string;
  hasBlocks: boolean;
  icon: string | null;
  fields: z.infer<typeof ContentTypeFieldSchema>[];
};

export interface ContentDto {
  id: string;
  siteId: string;
  contentType: { id: string; key: string; name: string };
  locale: string;
  /** The other language versions of this page share it. See CreateContentSchema. */
  translationGroupId: string;
  title: string;
  slug: string;
  /** Full path the site-runtime serves this at, e.g. "/blog/hello". */
  path: string;
  excerpt: string | null;
  data: Record<string, unknown>;
  blocks: z.infer<typeof BlockDocumentSchema>;
  seo: z.infer<typeof SeoSchema>;
  status: z.infer<typeof ContentStatusSchema>;
  publishedAt: string | null;
  author: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * One language version of a page, as the editor's translations panel lists them.
 *
 * Deliberately not part of ContentDto: fetching every page's siblings on every
 * list query would be an N+1 to draw a table that does not show them. The editor
 * asks for one page's translations, once.
 */
export interface TranslationDto {
  locale: string;
  /** Null when this locale has no translation yet — the panel offers to create it. */
  content: {
    id: string;
    title: string;
    slug: string;
    path: string;
    status: z.infer<typeof ContentStatusSchema>;
    updatedAt: string;
  } | null;
}

export interface MenuDto {
  key: string;
  name: string;
  items: MenuItemDto[];
}

export interface MenuItemDto {
  id: string;
  label: string;
  url: string;
  target: string;
  children: MenuItemDto[];
}

export interface MediaDto {
  id: string;
  url: string;
  filename: string;
  mimeType: string;
  size: number;
  width: number | null;
  height: number | null;
  alt: string | null;
  /** The folder it is filed in; null at the root of the library. */
  folderId: string | null;
  createdAt: string;
}

/**
 * One folder in the media library.
 *
 * `fileCount` counts the files filed directly in it, not the ones in its
 * subfolders. A folder card that showed a rolled-up total would say "12" and
 * open onto an empty grid, which is worse than saying nothing.
 */
export interface MediaFolderDto {
  id: string;
  name: string;
  parentId: string | null;
  fileCount: number;
  subfolderCount: number;
  createdAt: string;
}

/**
 * Renaming a file changes its *label*, never its URL: the object key is minted
 * at upload and is not derived from the name (see MediaService.upload). So a
 * rename cannot break a page that already embeds the file — which is exactly why
 * it is safe to offer.
 */
export const UpdateMediaSchema = z
  .object({
    filename: z.string().trim().min(1).max(255),
    // Explicit null clears the alt text. `undefined` (the key absent) leaves it
    // alone — the two must not collapse, or a move would wipe someone's alt.
    alt: z.string().trim().max(500).nullable(),
    folderId: z.uuid().nullable().describe("Null moves the file to the root."),
  })
  .partial();
export type UpdateMediaInput = z.infer<typeof UpdateMediaSchema>;

/**
 * The cap on a bulk operation.
 *
 * A ceiling, not a guess: the selection is built by clicking, and one request per
 * page of the grid is what the UI can actually produce. It also bounds the row
 * lock the delete takes — an unbounded `id IN (...)` is how a "tidy up the
 * library" click becomes a table lock on a live site.
 */
export const BULK_MEDIA_MAX = 100;

const MediaIdsSchema = z
  .array(z.uuid())
  .min(1)
  .max(BULK_MEDIA_MAX)
  .describe("Ids on this site. Ids belonging to another site are ignored, not an error.");

export const BulkDeleteMediaSchema = z.object({ ids: MediaIdsSchema });
export type BulkDeleteMediaInput = z.infer<typeof BulkDeleteMediaSchema>;

export const BulkMoveMediaSchema = z.object({
  ids: MediaIdsSchema,
  folderId: z.uuid().nullable().describe("Null moves them to the root."),
});
export type BulkMoveMediaInput = z.infer<typeof BulkMoveMediaSchema>;

/** Folder names are labels, not path segments — "/" is what makes them look like one. */
export const FOLDER_NAME_MAX = 60;
const FolderNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(FOLDER_NAME_MAX)
  .refine((name) => !name.includes("/") && !name.includes("\\"), {
    message: "A folder name cannot contain a slash.",
  });

export const CreateMediaFolderSchema = z.object({
  name: FolderNameSchema,
  parentId: z.uuid().nullish().describe("Omit to create the folder at the root."),
});
export type CreateMediaFolderInput = z.infer<typeof CreateMediaFolderSchema>;

export const UpdateMediaFolderSchema = z
  .object({
    name: FolderNameSchema,
    parentId: z.uuid().nullable().describe("Null moves the folder to the root."),
  })
  .partial();
export type UpdateMediaFolderInput = z.infer<typeof UpdateMediaFolderSchema>;

// ---------------------------------------------------------------------------
// Site-runtime render contract
// ---------------------------------------------------------------------------

/**
 * Everything site-runtime needs to render one URL, in one round trip.
 *
 * Deliberately a single call: a public page render must not fan out into
 * separate requests for the site, the theme, the menus and the content. One
 * cached payload per path is what keeps a cold render cheap and makes cache
 * invalidation a single key to delete.
 */
/**
 * The same page in another language, and where it lives.
 *
 * `path` is final — already carrying the locale prefix, ready to be used as an
 * href. It is *not* passed through `ctx.url()`, which prefixes with the locale of
 * the page currently being rendered: doing that to a link that points at another
 * language would produce "/vi/en/about".
 *
 * A translation is free to have a completely different slug — "/about" and
 * "/vi/gioi-thieu" are one page — which is why this cannot be derived by a theme
 * and has to be sent.
 */
export interface LocaleAlternate {
  locale: string;
  path: string;
  /** True for the one being rendered. Saves every theme writing the comparison. */
  current: boolean;
  /**
   * The flag for this language, ready to put in an `<img src>` — or null, which
   * is a normal answer and not a missing one (Arabic has no flag; see flags.ts in
   * `@zcmsorg/i18n`).
   *
   * Sent, rather than derived by the theme, for the same reason `path` is: a
   * site's languages are rows in its database, so the theme cannot know them at
   * build time. A theme carrying its own language→flag table would need a release
   * every time a site added a language — and the switcher in `themes/default` was
   * written specifically to avoid that (it names languages with `Intl.DisplayNames`
   * and no table). This keeps that property: the platform resolves the flag, the
   * theme renders whatever it is handed, and a theme that ignores this field
   * behaves exactly as before.
   */
  flagUrl: string | null;
}

/** Public, cacheable data exposed by one active plugin capability. */
export interface RenderIntegration<T = unknown> {
  capability: string;
  provider: {
    pluginKey: string;
    version: string;
  };
  data: T;
}

export interface RenderPayload {
  site: {
    id: string;
    name: string;
    /**
     * The site's primary hostname. A request that arrives on any other spelling of
     * it — "www.z-cms.org" for a site created as "z-cms.org" — is redirected here,
     * so that one page has one address rather than two that rank against each other.
     */
    canonicalHost: string;
    /** The locale this URL was resolved in — not the site's default. */
    locale: string;
    /** Served unprefixed. Every other locale carries its code: "/vi/blog". */
    defaultLocale: string;
    /** Every locale this site publishes in. */
    locales: string[];
    /**
     * The site's own colour and logo, for a theme to use wherever it wants:
     *
     *   <img src={ctx.site.brand.logo} />
     *   style={{ "--brand": ctx.site.brand.primaryColor }}
     *
     * Always present, never null — a site with no brand set gets the platform's
     * default, so a theme never has to guard before reading it.
     */
    brand: SiteBrand;
  };
  theme: {
    key: string;
    version: string;
    /**
     * Which trust route site-runtime verifies this theme against — the version's
     * stored origin. Carried so the runtime never infers it from the key: BUILTIN is
     * checked against the first-party key, MARKETPLACE against the marketplace key,
     * SIDELOAD against the operator key. Optional so an older cms-api that omits it
     * still parses; site-runtime treats a missing value as the marketplace route,
     * and independently refuses to send a built-in key down anything but the
     * built-in path.
     */
    origin?: "BUILTIN" | "MARKETPLACE" | "SIDELOAD";
    /** Values for the theme's declared settings schema. */
    settings: Record<string, unknown>;
  };
  /** Keyed by menu location, e.g. "primary" / "footer". */
  menus: Record<string, MenuDto>;
  /**
   * The lists the active theme asked for in its manifest, already run.
   *
   * This is what lets a magazine's front page show the site's actual lead story and
   * a shop's home page its actual products. Before it existed a theme could only see
   * the ONE page being rendered, so a front page that wanted six headlines had no
   * choice but to invent them — and a news theme whose front page does not show your
   * news is a brochure, not a theme.
   *
   * Keyed by the name the theme chose ("latest", "featured"). A theme that declares
   * nothing gets an empty object; a name whose content type does not exist on this
   * site gets an empty array, never a missing key — so a template can map over it
   * without a guard, on every site, on the day the theme is installed and before any
   * content has been written.
   */
  collections: Record<string, ContentDto[]>;
  /** The matched content, or null when nothing lives at this path (404). */
  content: ContentDto | null;
  /**
   * Set when the path is an archive route (e.g. "/blog") rather than a single
   * piece of content: the list the theme's `archive` template renders.
   */
  archive: {
    contentTypeKey: string;
    title: string;
    /**
     * The URL this archive lives at, e.g. "/blog". Sent explicitly because a
     * theme cannot derive it: the route prefix is a property of the content
     * type, not of the key, and an empty archive has no item to read it from.
     */
    basePath: string;
    items: ContentDto[];
    page: number;
    totalPages: number;
  } | null;
  /**
   * This URL in every locale it exists in — the language switcher, and hreflang.
   *
   * Only locales the page *actually* exists in are listed. A post translated into
   * Vietnamese but not Japanese offers two entries, not three: a switcher that
   * links to a language and lands the reader on a 404 is worse than one that does
   * not offer it, and `hreflang` pointing at a missing page is an SEO error.
   *
   * Empty on a 404, and a single self-entry on a monolingual site.
   */
  alternates: LocaleAlternate[];
  /** Capabilities contributed by active plugins; themes feature-detect on these. */
  capabilities: string[];
  /**
   * Public plugin projections keyed by capability. Plugin settings are private by
   * default; only a core-owned projector may place an allow-listed view here.
   */
  integrations: Record<string, RenderIntegration>;
  /** Safe, public zAI presentation settings. Provider keys never enter this payload. */
  aiAssistant?: { name: string; welcomeMessage: string };
}
