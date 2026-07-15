import { MAX_SCREENSHOTS, type SignedRevocationList } from "@zcmsorg/package";
import type { FailedJob, FailedJobPage } from "@zcmsorg/queue";
import {
  AcceptInviteSchema,
  AuthResultSchema,
  BlockDocumentSchema,
  BlockSchema,
  ChangePasswordSchema,
  ContentStatusSchema,
  ContentTypeFieldSchema,
  CreateUserSchema,
  CreateContentSchema,
  BulkDeleteMediaSchema,
  BulkMoveMediaSchema,
  CreateContentTypeSchema,
  CreateMediaFolderSchema,
  DisableTotpSchema,
  EnableTotpSchema,
  HOSTNAME_RE,
  InviteUserSchema,
  LoginSchema,
  normalizeHostname,
  MailMessageSchema,
  MailSettingsSchema,
  MfaChallengeSchema,
  MfaVerifySchema,
  SiteBrandSchema,
  PermissionSchema,
  SendTestMailSchema,
  RegenerateRecoveryCodesSchema,
  RoleSchema,
  SeoSchema,
  SessionUserSchema,
  SetMembershipSchema,
  UpdateContentSchema,
  UpdateMediaFolderSchema,
  UpdateMediaSchema,
  UpdateProfileSchema,
  type ContentDto,
  type ContentTypeDto,
  type InvitationCreatedDto,
  type InvitationDto,
  type LocaleAlternate,
  type MediaDto,
  type MailSettingsDto,
  type MediaFolderDto,
  type MembershipDto,
  type MenuDto,
  type MenuItemDto,
  type RecoveryCodesDto,
  type RenderPayload,
  type SiteDto,
  type TotpSetupDto,
  type TranslationDto,
  type UserDto,
  type UserCreatedDto,
} from "@zcmsorg/schemas";
import { z } from "zod";
import type {
  BrowsePackage,
  MarketplaceStatus,
  RegistryPackage,
} from "../marketplace/marketplace.module";
import type { CatalogPlugin } from "../plugins/plugins.controller";
import type { CatalogTheme, InstalledTheme } from "../themes/themes.module";

/**
 * Every schema the OpenAPI document names, generated from the Zod contracts the
 * API already validates with.
 *
 * The point is that the document cannot lie. A hand-written spec — or a parallel
 * set of `class` DTOs annotated for Swagger — is a second description of the same
 * wire format, and a second description drifts the first time someone adds a
 * field. Here, a request body's schema IS the schema the pipe rejects on, and a
 * response's schema is checked against the DTO type at compile time (see the
 * drift assertions at the bottom): documenting a field the API does not return,
 * or forgetting one it does, fails `tsc`.
 *
 * Requests and responses are generated from two registries because the same Zod
 * object describes two different shapes on the wire: `status` is optional in a
 * POST body (it defaults to DRAFT) and always present in the response. That is
 * Zod's input/output distinction, and collapsing it would document a required
 * response field as optional.
 */

/** Named components generated with `io: "input"` — what a client may send. */
const requests = z.registry<{ id: string }>();
/** Named components generated with `io: "output"` — what the API returns. */
const responses = z.registry<{ id: string }>();

const ref = (id: string) => `#/components/schemas/${id}`;

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/**
 * Recursive schemas MUST be registered. Zod can only express a self-reference as
 * a `$ref`, and an unregistered one lands in a `definitions` block that OpenAPI
 * has no place for — Swagger UI renders it as a broken link. Registered, the
 * reference points at a real component. Non-recursive helpers (Seo, enums) are
 * left unregistered on purpose: inlined, they read better in the UI.
 */
requests.add(BlockSchema, { id: "BlockInput" });

export const RefreshTokenSchema = z.object({ refreshToken: z.string().min(1) });

/** Mirrors the recursive menu item accepted by PUT /menus/{key}. */
interface MenuItemInput {
  label: string;
  url: string;
  target?: string;
  children?: MenuItemInput[];
}
const MenuItemInputSchema: z.ZodType<MenuItemInput> = z.lazy(() =>
  z.object({
    label: z.string().min(1),
    url: z.string().min(1),
    target: z.enum(["_self", "_blank"]).default("_self"),
    children: z.array(MenuItemInputSchema).optional(),
  }),
);
requests.add(MenuItemInputSchema, { id: "MenuItemInput" });

export const PutMenuSchema = z.object({
  name: z.string().min(1),
  items: z.array(MenuItemInputSchema).default([]),
});

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

/**
 * A hostname, and the port is part of it.
 *
 * Not a URL and not `z.hostname()`: site-runtime resolves a site by the Host
 * header verbatim, and in development that header is "localhost:3100". A rule
 * that rejected the port would make it impossible to create, through the API, the
 * one kind of site a developer can actually open.
 *
 * What it *stores* is a hostname; what it *accepts* is also a pasted URL, which
 * `normalizeHostname` reduces to one. The value that reaches the database is
 * normalized either way, so the unique index still sees "z-cms.org" once, no
 * matter which of its spellings two callers happened to send.
 */
const HostnameSchema = z
  .string()
  .transform(normalizeHostname)
  .pipe(
    z
      .string()
      .min(1)
      .max(253)
      .regex(HOSTNAME_RE, 'A hostname, optionally with a port — "example.com" or "localhost:3100".'),
  );

const SlugSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Lowercase letters, digits and single hyphens.");

export const CreateSiteSchema = z.object({
  name: z.string().min(1).max(120),
  slug: SlugSchema,
  /**
   * Required, not optional. A site with no domain cannot be resolved by any
   * request — site-runtime knows only the Host header — so a "site" without one
   * is a row that no visitor can ever reach. Creating it in the same transaction
   * is what makes a newly created site a real thing rather than a promise.
   */
  hostname: HostnameSchema,
  defaultLocale: z.string().min(2).max(10).default("vi"),
  locales: z.array(z.string().min(2).max(10)).min(1).optional(),
  brand: SiteBrandSchema.optional(),
  /**
   * Publish on creation, rather than in a second call.
   *
   * Defaults to false, and the default is the important half: a site nobody has
   * chosen a theme for should not be answering requests. But when the caller
   * already knows it wants the site live, doing it here makes it one atomic
   * operation — the alternative is a create followed by a PATCH, which can fail
   * halfway and leave a site that exists, is unreachable, and that nobody was
   * told to go and publish.
   */
  publish: z.boolean().default(false),
});

export const UpdateSiteSchema = z
  .object({
    name: z.string().min(1).max(120),
    slug: SlugSchema,
    hostname: HostnameSchema,
    // A new site is DRAFT, and DRAFT does not render — `resolveHost` refuses any
    // site that is not PUBLISHED. So publishing is an *update*, and this is it.
    status: z.enum(["DRAFT", "PUBLISHED", "SUSPENDED", "ARCHIVED"]),
    defaultLocale: z.string().min(2).max(10),
    locales: z.array(z.string().min(2).max(10)).min(1),
    brand: SiteBrandSchema,
  })
  .partial();

export const InstallPluginSchema = z.object({
  grantedPermissions: z
    .array(PermissionSchema)
    .optional()
    .describe("Omit to grant everything the plugin requests."),
});

export const SettingsSchema = z
  .record(z.string(), z.unknown())
  .describe("Free-form settings, filtered against the package's declared schema.");

export const RunJobSchema = z.object({
  tenantId: z.uuid(),
  siteId: z.uuid(),
  pluginKey: z.string(),
  name: z.string(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

export const GatewayCallSchema = z.object({
  method: z.string().describe('Host method, e.g. "content.list".'),
  params: z.record(z.string(), z.unknown()).optional(),
});

/** What the worker posts back to /mail/deliver. The job payload, as JSON. */
export const DeliverMailSchema = z.object({
  tenantId: z.uuid(),
  siteId: z.uuid(),
  message: MailMessageSchema,
  pluginKey: z
    .string()
    .nullable()
    .describe("The plugin that asked for this mail. Null when the CMS itself did."),
  error: z.string().optional().describe("Only on /mail/dead-letter: why it never arrived."),
});

requests.add(LoginSchema, { id: "LoginInput" });
requests.add(RefreshTokenSchema, { id: "RefreshTokenInput" });
requests.add(AcceptInviteSchema, { id: "AcceptInviteInput" });
requests.add(CreateUserSchema, { id: "CreateUserInput" });
requests.add(InviteUserSchema, { id: "InviteUserInput" });
requests.add(SetMembershipSchema, { id: "SetMembershipInput" });
requests.add(UpdateProfileSchema, { id: "UpdateProfileInput" });
requests.add(ChangePasswordSchema, { id: "ChangePasswordInput" });
requests.add(MfaVerifySchema, { id: "MfaVerifyInput" });
requests.add(EnableTotpSchema, { id: "EnableTotpInput" });
requests.add(DisableTotpSchema, { id: "DisableTotpInput" });
requests.add(RegenerateRecoveryCodesSchema, { id: "RegenerateRecoveryCodesInput" });
requests.add(CreateContentSchema, { id: "CreateContentInput" });
requests.add(UpdateContentSchema, { id: "UpdateContentInput" });
requests.add(CreateContentTypeSchema, { id: "CreateContentTypeInput" });
requests.add(UpdateMediaSchema, { id: "UpdateMediaInput" });
requests.add(BulkMoveMediaSchema, { id: "BulkMoveMediaInput" });
requests.add(BulkDeleteMediaSchema, { id: "BulkDeleteMediaInput" });
requests.add(CreateMediaFolderSchema, { id: "CreateMediaFolderInput" });
requests.add(UpdateMediaFolderSchema, { id: "UpdateMediaFolderInput" });
requests.add(CreateSiteSchema, { id: "CreateSiteInput" });
requests.add(UpdateSiteSchema, { id: "UpdateSiteInput" });
requests.add(PutMenuSchema, { id: "PutMenuInput" });
requests.add(InstallPluginSchema, { id: "InstallPluginInput" });
requests.add(SettingsSchema, { id: "SettingsInput" });
requests.add(RunJobSchema, { id: "RunJobInput" });
requests.add(GatewayCallSchema, { id: "GatewayCallInput" });
requests.add(MailSettingsSchema, { id: "MailSettingsInput" });
requests.add(SendTestMailSchema, { id: "SendTestMailInput" });
requests.add(DeliverMailSchema, { id: "DeliverMailInput" });

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

const SiteDtoSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  status: z.enum(["DRAFT", "PUBLISHED", "SUSPENDED", "ARCHIVED"]),
  defaultLocale: z.string(),
  locales: z.array(z.string()),
  // The response always carries a complete brand, so `.required()`: SiteBrandSchema
  // has defaults, which make its OUTPUT type optional, and a DTO whose colour might
  // be undefined would make every theme guard a value the API guarantees.
  brand: SiteBrandSchema.required(),
  domains: z.array(
    z.object({ id: z.uuid(), hostname: z.string(), isPrimary: z.boolean() }),
  ),
  activeTheme: z
    .object({ key: z.string(), name: z.string(), version: z.string() })
    .nullable(),
});

const ContentTypeDtoSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  name: z.string(),
  pluralName: z.string(),
  description: z.string().nullable(),
  isSingleton: z.boolean(),
  isRoutable: z.boolean(),
  routePrefix: z.string(),
  hasBlocks: z.boolean(),
  icon: z.string().nullable(),
  fields: z.array(ContentTypeFieldSchema),
});

const ContentDtoSchema = z.object({
  id: z.uuid(),
  siteId: z.uuid(),
  contentType: z.object({ id: z.uuid(), key: z.string(), name: z.string() }),
  locale: z.string(),
  translationGroupId: z
    .uuid()
    .describe("Shared by the other language versions of this same page."),
  title: z.string(),
  slug: z.string(),
  path: z.string().describe('Where site-runtime serves this, e.g. "/blog/hello".'),
  excerpt: z.string().nullable(),
  data: z.record(z.string(), z.unknown()),
  blocks: BlockDocumentSchema,
  seo: SeoSchema,
  status: ContentStatusSchema,
  publishedAt: z.iso.datetime().nullable(),
  author: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const TranslationDtoSchema = z.object({
  locale: z.string(),
  content: z
    .object({
      id: z.uuid(),
      title: z.string(),
      slug: z.string(),
      path: z.string(),
      status: ContentStatusSchema,
      updatedAt: z.iso.datetime(),
    })
    .nullable()
    .describe("Null when this locale has no translation yet."),
});

const MenuItemDtoSchema: z.ZodType<MenuItemDto> = z.lazy(() =>
  z.object({
    id: z.uuid(),
    label: z.string(),
    url: z.string(),
    target: z.string(),
    children: z.array(MenuItemDtoSchema),
  }),
);

const MenuDtoSchema = z.object({
  key: z.string(),
  name: z.string(),
  items: z.array(MenuItemDtoSchema),
});

const MediaDtoSchema = z.object({
  id: z.uuid(),
  url: z.url(),
  filename: z.string(),
  mimeType: z.string(),
  size: z.int(),
  width: z.int().nullable(),
  height: z.int().nullable(),
  alt: z.string().nullable(),
  folderId: z.uuid().nullable().describe("Null at the root of the library."),
  createdAt: z.iso.datetime(),
});

const MediaFolderDtoSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  parentId: z.uuid().nullable(),
  fileCount: z.int().describe("Files filed directly in it — not in its subfolders."),
  subfolderCount: z.int(),
  createdAt: z.iso.datetime(),
});

const LocaleAlternateSchema = z.object({
  locale: z.string(),
  path: z.string(),
  current: z.boolean(),
  // Nullable, and that is not an omission: a language no single country speaks
  // for (Arabic, Esperanto) has no flag, and the theme renders its name alone.
  flagUrl: z.string().nullable(),
});

const RenderPayloadSchema = z.object({
  site: z.object({
    id: z.uuid(),
    name: z.string(),
    // The site's primary hostname. site-runtime redirects any other spelling of it
    // ("www.z-cms.org" for a site created as "z-cms.org") here, so that one page
    // has one address.
    canonicalHost: z.string(),
    locale: z.string(),
    defaultLocale: z.string(),
    locales: z.array(z.string()),
    // Always complete — see SiteDtoSchema. A theme reads `ctx.site.brand.logo`
    // without guarding, and this is the promise that lets it.
    brand: SiteBrandSchema.required(),
  }),
  theme: z.object({
    key: z.string(),
    version: z.string(),
    settings: z.record(z.string(), z.unknown()),
  }),
  menus: z.record(z.string(), MenuDtoSchema),
  // The lists the active theme declared in its manifest, already run: keyed by the
  // theme's own name for each ("latest", "featured"). Empty object for a theme that
  // declares none; an empty array — never a missing key — for a name whose content
  // type this site does not have.
  collections: z.record(z.string(), z.array(ContentDtoSchema)),
  content: ContentDtoSchema.nullable(),
  archive: z
    .object({
      contentTypeKey: z.string(),
      title: z.string(),
      basePath: z.string(),
      items: z.array(ContentDtoSchema),
      page: z.int(),
      totalPages: z.int(),
    })
    .nullable(),
  alternates: z.array(LocaleAlternateSchema),
  capabilities: z.array(z.string()),
  integrations: z.record(
    z.string(),
    z.object({
      capability: z.string(),
      provider: z.object({ pluginKey: z.string(), version: z.string() }),
      data: z.unknown(),
    }),
  ),
  // Deprecated compatibility field. New consumers use integrations["ai.assistant"].
  aiAssistant: z.object({ name: z.string(), welcomeMessage: z.string() }).optional(),
});

const CatalogPluginSchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  publisher: z.string(),
  isCore: z.boolean(),
  latestVersion: z.string().nullable(),
  origin: z.string().nullable(),
  reviewStatus: z.string().nullable(),
  permissions: z.array(PermissionSchema).describe("What the plugin asks the admin to approve."),
  capabilities: z.array(z.string()),
  networkHosts: z
    .array(z.string())
    .describe(
      "The hosts the plugin declared it will reach. Shown beside `network:fetch` on the " +
        "consent screen — that scope grants exactly this list and nothing wider.",
    ),
  settingsSchema: z.unknown(),
  installed: z.boolean(),
  status: z.string().nullable(),
  grantedPermissions: z.array(PermissionSchema).nullable().describe("Non-null only when installed."),
  settings: z.record(z.string(), z.unknown()).nullable(),
  lastError: z.string().nullable(),
});

const CatalogThemeSchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  author: z.string(),
  isCore: z.boolean(),
  screenshots: z.array(z.url()).max(MAX_SCREENSHOTS),
  versions: z.array(
    z.object({ version: z.string(), origin: z.string(), reviewStatus: z.string() }),
  ),
});

const InstalledThemeSchema = z.object({
  key: z.string(),
  name: z.string(),
  version: z.string(),
  status: z.string(),
  origin: z.string(),
  reviewStatus: z.string(),
  settings: z.record(z.string(), z.unknown()),
  settingsSchema: z.unknown(),
  demoAvailable: z.boolean(),
  demoSeeded: z.boolean(),
  screenshots: z.array(z.url()).max(MAX_SCREENSHOTS),
});

/**
 * The enrollment payload. `secret` is in the response on purpose — it is what a
 * user types when they cannot scan — and it is the reason this endpoint is a POST
 * behind a session rather than anything cacheable.
 */
const TotpSetupDtoSchema = z.object({
  secret: z.string().describe("Base32 shared secret, for manual entry."),
  otpauthUrl: z.string().describe("What the QR encodes. otpauth://totp/..."),
});

const RecoveryCodesDtoSchema = z.object({
  recoveryCodes: z
    .array(z.string())
    .describe("Shown once. Only their hashes are stored — there is no way to see them again."),
});

const MembershipDtoSchema = z.object({
  id: z.uuid(),
  role: RoleSchema,
  siteId: z.uuid().nullable().describe("Null grants the role across the whole tenant."),
  siteName: z.string().nullable().describe("Null for a tenant-wide membership — there is no one site to name."),
});

const UserDtoSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  name: z.string(),
  avatarUrl: z.string().nullable(),
  lastLoginAt: z.iso.datetime().nullable().describe("Null until they have signed in once."),
  twoFactorEnabled: z
    .boolean()
    .describe("Whether this account is protected by a second factor. Visible to `user:read`."),
  createdAt: z.iso.datetime(),
  memberships: z.array(MembershipDtoSchema),
});

const InvitationDtoSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  role: RoleSchema,
  siteId: z.uuid().nullable(),
  siteName: z.string().nullable(),
  invitedByName: z.string().nullable().describe("Null if that account has since been removed."),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});

/** The only response that carries a raw invite token, and the only time it exists. */
const InvitationCreatedSchema = z.object({
  invitation: InvitationDtoSchema,
  token: z
    .string()
    .describe("Shown once. Only its hash is stored — there is no way to retrieve it again."),
});

const UserCreatedSchema = z.object({
  user: UserDtoSchema,
  password: z.string().describe("Shown once and included in the account-created email when mail is configured."),
  loginUrl: z.url(),
  emailQueued: z.boolean(),
});

const FailedJobSchema = z.object({
  id: z.string(),
  name: z.string(),
  attemptsMade: z.int(),
  failedReason: z.string(),
  failedAt: z.iso.datetime().nullable(),
  data: z.record(z.string(), z.unknown()),
});

/** One page of the dead-letter queue, plus how deep it actually is. */
const FailedJobPageSchema = z.object({
  items: z.array(FailedJobSchema),
  total: z.int().describe("Total failed jobs, not just the ones on this page."),
});

// ---------------------------------------------------------------------------
// Marketplace
// ---------------------------------------------------------------------------

const PackageKindSchema = z.enum(["theme", "plugin"]);

const RegistryPackageSchema = z.object({
  kind: PackageKindSchema,
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  author: z.string(),
  publisher: z
    .object({ slug: z.string(), name: z.string(), verified: z.boolean() })
    .nullable()
    .describe("The publisher as the MARKETPLACE knows them. A consumer displays this; it does not import it."),
  latestVersion: z.string(),
  versions: z.array(z.string()),
  permissions: z
    .array(z.string())
    .describe("What the newest version asks for — a plugin's real price, shown before install."),
  screenshots: z
    .array(z.url())
    .max(MAX_SCREENSHOTS)
    .describe(
      "Up to three screenshots of the newest version, as absolute URLs on the marketplace. " +
        "They live inside the signed package, so they cannot be swapped without breaking a signature.",
    ),
  video: z
    .string()
    .nullable()
    .describe("An external video URL (YouTube, Vimeo, …). Never a file inside the package."),
  updatedAt: z.iso.datetime(),
});

const BrowsePackageSchema = RegistryPackageSchema.extend({
  installed: z.boolean().describe("Already in this instance's catalogue."),
  installedVersion: z
    .string()
    .nullable()
    .describe("The version this instance holds, so the UI can offer an update."),
});

const MarketplaceStatusSchema = z.object({
  url: z.string().nullable().describe("Where this instance shops. Null when it is its own marketplace."),
  lastSyncedAt: z.iso.datetime().nullable(),
  lastError: z.string().nullable(),
  revokedCount: z.int(),
  stale: z
    .boolean()
    .describe("The last accepted revocation list is old. The whole fail-open design rests on this being visible."),
});

const RevocationSchema = z.object({
  kind: PackageKindSchema,
  key: z.string(),
  version: z.string(),
  reason: z.string(),
  revokedAt: z.iso.datetime(),
});

/**
 * Signed, and that is the point: a revocation list an attacker can forge is a
 * remote uninstall button for anyone who can answer a DNS query. Consumers verify
 * `signature` against the marketplace key pinned in their own config, and MUST
 * recompute `digest` rather than trust the one sent.
 */
const SignedRevocationListSchema = z.object({
  issuedAt: z.iso.datetime().describe("Consumers refuse a list older than the newest they accepted — that is the replay defence."),
  revoked: z.array(RevocationSchema).describe("A full snapshot, not a delta."),
  digest: z.string().describe("SHA-256 of the canonical form. Advisory: recompute it."),
  signature: z.string().describe("Ed25519 by the marketplace, over the digest."),
});

const MarketplaceInstalledSchema = z.object({
  ok: z.literal(true),
  kind: z.string(),
  key: z.string(),
  version: z.string(),
});

const MarketplaceSyncSchema = z.object({
  ok: z.boolean(),
  applied: z.int().describe("Revocations newly enforced by this sync."),
  error: z.string().optional().describe("Why the sync failed. It fails open — see `stale` on /marketplace/status."),
});

/**
 * The mail configuration, as the admin screen sees it.
 *
 * There is no `password` field and there is no room for one — the DTO this is
 * checked against (below) does not declare it either, so a future hand that adds
 * it to the service has to add it here too, in the open, in a diff.
 */
const MailSettingsDtoSchema = z.object({
  enabled: z.boolean(),
  host: z.string(),
  port: z.int(),
  secure: z.boolean().describe("Implicit TLS (SMTPS/465). Off still STARTTLSes when the server offers it."),
  username: z.string().nullable(),
  hasPassword: z.boolean().describe("Whether one is stored. Never the password, nor its length."),
  fromName: z.string(),
  fromEmail: z.email(),
  replyTo: z.string().nullable(),
  lastTestAt: z.iso.datetime().nullable().describe("Null until someone has pressed 'send a test'."),
  lastTestError: z.string().nullable().describe("The SMTP server's own words. Null if the last test passed."),
  fromEnv: z.boolean().describe("Nothing is saved; these came from SMTP_* in the environment."),
});

/**
 * A send that was attempted, not one that was queued.
 *
 * `ok: false` is a 200: the request was valid and the platform is fine — the mail
 * *server* refused. Same reasoning as a plugin whose setup() throws.
 */
const MailTestResultSchema = z.object({
  ok: z.boolean(),
  messageId: z.string().optional().describe("The SMTP server's accept id, when it gave one."),
  cancelled: z.boolean().optional().describe("A `mail.sending` plugin filter refused the send."),
  error: z.string().optional().describe("The mail server's own refusal, verbatim."),
});

/** The answer from an action that either happened or raised. */
const OkSchema = z.object({ ok: z.literal(true) });

const PluginInstalledSchema = z.object({
  ok: z.literal(true),
  granted: z
    .array(PermissionSchema)
    .describe("What the plugin may actually do — never more than it requested."),
});

/**
 * Activation answers 200 with `ok: false` when the plugin's own `setup()` throws.
 *
 * Not a 4xx and not a 500: the request was valid and the platform is fine — the
 * *plugin* is broken. The status stays ERROR, the message is the plugin's, and
 * the admin sees which one to blame.
 */
const PluginActivationSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional().describe("The plugin's own failure message, when ok is false."),
});

/** The error body every 4xx/5xx carries. Nest's exception filter shape. */
const ErrorSchema = z.object({
  statusCode: z.int(),
  message: z.union([z.string(), z.array(z.string())]),
  error: z.string().optional(),
  errors: z
    .array(z.object({ path: z.string(), message: z.string() }))
    .optional()
    .describe("Present on Zod validation failures: one entry per rejected field."),
});

responses.add(SessionUserSchema, { id: "SessionUser" });
responses.add(AuthResultSchema, { id: "AuthResult" });
responses.add(BlockSchema, { id: "Block" });
responses.add(SiteDtoSchema, { id: "SiteDto" });
responses.add(ContentTypeDtoSchema, { id: "ContentTypeDto" });
responses.add(ContentDtoSchema, { id: "ContentDto" });
responses.add(TranslationDtoSchema, { id: "TranslationDto" });
responses.add(MenuItemDtoSchema, { id: "MenuItemDto" });
responses.add(MenuDtoSchema, { id: "MenuDto" });
responses.add(MediaDtoSchema, { id: "MediaDto" });
responses.add(MediaFolderDtoSchema, { id: "MediaFolderDto" });
responses.add(MfaChallengeSchema, { id: "MfaChallenge" });
responses.add(TotpSetupDtoSchema, { id: "TotpSetup" });
responses.add(RecoveryCodesDtoSchema, { id: "RecoveryCodes" });
responses.add(MembershipDtoSchema, { id: "MembershipDto" });
responses.add(UserDtoSchema, { id: "UserDto" });
responses.add(InvitationDtoSchema, { id: "InvitationDto" });
responses.add(InvitationCreatedSchema, { id: "InvitationCreated" });
responses.add(UserCreatedSchema, { id: "UserCreated" });
responses.add(RenderPayloadSchema, { id: "RenderPayload" });
responses.add(CatalogPluginSchema, { id: "CatalogPlugin" });
responses.add(CatalogThemeSchema, { id: "CatalogTheme" });
responses.add(InstalledThemeSchema, { id: "InstalledTheme" });
responses.add(FailedJobSchema, { id: "FailedJob" });
responses.add(FailedJobPageSchema, { id: "FailedJobPage" });
responses.add(RegistryPackageSchema, { id: "RegistryPackage" });
responses.add(BrowsePackageSchema, { id: "BrowsePackage" });
responses.add(MarketplaceStatusSchema, { id: "MarketplaceStatus" });
responses.add(SignedRevocationListSchema, { id: "SignedRevocationList" });
responses.add(MarketplaceInstalledSchema, { id: "MarketplaceInstalled" });
responses.add(MarketplaceSyncSchema, { id: "MarketplaceSync" });
responses.add(MailSettingsDtoSchema, { id: "MailSettings" });
responses.add(MailTestResultSchema, { id: "MailTestResult" });
responses.add(OkSchema, { id: "Ok" });
responses.add(PluginInstalledSchema, { id: "PluginInstalled" });
responses.add(PluginActivationSchema, { id: "PluginActivation" });
responses.add(ErrorSchema, { id: "Error" });

/** Ids usable in `@ApiZodResponse` / `@ApiZodBody`, checked by the compiler. */
export type RequestSchemaId =
  | "CreateSiteInput"
  | "UpdateSiteInput"
  | "LoginInput"
  | "RefreshTokenInput"
  | "AcceptInviteInput"
  | "CreateUserInput"
  | "InviteUserInput"
  | "SetMembershipInput"
  | "UpdateProfileInput"
  | "ChangePasswordInput"
  | "MfaVerifyInput"
  | "EnableTotpInput"
  | "DisableTotpInput"
  | "RegenerateRecoveryCodesInput"
  | "CreateContentInput"
  | "UpdateContentInput"
  | "CreateContentTypeInput"
  | "UpdateMediaInput"
  | "BulkMoveMediaInput"
  | "BulkDeleteMediaInput"
  | "CreateMediaFolderInput"
  | "UpdateMediaFolderInput"
  | "PutMenuInput"
  | "InstallPluginInput"
  | "SettingsInput"
  | "RunJobInput"
  | "GatewayCallInput"
  | "MailSettingsInput"
  | "SendTestMailInput"
  | "DeliverMailInput"

export type ResponseSchemaId =
  | "SessionUser"
  | "AuthResult"
  | "MfaChallenge"
  | "TotpSetup"
  | "RecoveryCodes"
  | "UserDto"
  | "MembershipDto"
  | "InvitationDto"
  | "InvitationCreated"
  | "UserCreated"
  | "SiteDto"
  | "ContentTypeDto"
  | "ContentDto"
  | "TranslationDto"
  | "MenuDto"
  | "MediaDto"
  | "MediaFolderDto"
  | "FolderDeleted"
  | "RenderPayload"
  | "CatalogPlugin"
  | "CatalogTheme"
  | "InstalledTheme"
  | "FailedJob"
  | "FailedJobPage"
  | "RegistryPackage"
  | "BrowsePackage"
  | "MarketplaceStatus"
  | "SignedRevocationList"
  | "MarketplaceInstalled"
  | "MarketplaceSync"
  | "MailSettings"
  | "MailTestResult"
  | "Ok"
  | "PluginInstalled"
  | "PluginActivation"
  | "Error";

export const schemaRef = (id: RequestSchemaId | ResponseSchemaId) => ref(id);

/**
 * The `components.schemas` block, built once and merged into the document.
 *
 * Nest's `extraModels` only understands decorated classes, so Zod-derived
 * components are injected straight into the generated document instead.
 */
export function buildComponentSchemas(): Record<string, unknown> {
  const asComponents = (out: { schemas: Record<string, unknown> }) => {
    for (const schema of Object.values(out.schemas)) {
      // `$id` is how Zod echoes the ref target back; OpenAPI 3.0 has no such
      // keyword and older tooling chokes on it.
      delete (schema as { $id?: unknown }).$id;
    }
    return out.schemas;
  };

  return {
    ...asComponents(
      z.toJSONSchema(requests, { target: "openapi-3.0", io: "input", uri: ref }) as {
        schemas: Record<string, unknown>;
      },
    ),
    ...asComponents(
      z.toJSONSchema(responses, { target: "openapi-3.0", io: "output", uri: ref }) as {
        schemas: Record<string, unknown>;
      },
    ),
  };
}

// ---------------------------------------------------------------------------
// Drift assertions
// ---------------------------------------------------------------------------

/**
 * Response DTOs are plain TypeScript interfaces — nothing forces a schema above
 * to keep describing one. These do: each pair must be mutually assignable, so
 * renaming a DTO field without touching its schema is a build failure, not a
 * quietly wrong document. `-?` normalises `z.unknown()` keys, which Zod infers as
 * optional because `unknown` admits `undefined`.
 */
type Exact<A, B> =
  [{ [K in keyof A]-?: A[K] }] extends [{ [K in keyof B]-?: B[K] }]
    ? [{ [K in keyof B]-?: B[K] }] extends [{ [K in keyof A]-?: A[K] }]
      ? true
      : false
    : false;

const _noDrift: [
  Exact<z.infer<typeof TotpSetupDtoSchema>, TotpSetupDto>,
  Exact<z.infer<typeof RecoveryCodesDtoSchema>, RecoveryCodesDto>,
  Exact<z.infer<typeof MembershipDtoSchema>, MembershipDto>,
  Exact<z.infer<typeof UserDtoSchema>, UserDto>,
  Exact<z.infer<typeof InvitationDtoSchema>, InvitationDto>,
  Exact<z.infer<typeof InvitationCreatedSchema>, InvitationCreatedDto>,
  Exact<z.infer<typeof UserCreatedSchema>, UserCreatedDto>,
  Exact<z.infer<typeof SiteDtoSchema>, SiteDto>,
  Exact<z.infer<typeof ContentTypeDtoSchema>, ContentTypeDto>,
  Exact<z.infer<typeof ContentDtoSchema>, ContentDto>,
  Exact<z.infer<typeof TranslationDtoSchema>, TranslationDto>,
  Exact<z.infer<typeof MenuDtoSchema>, MenuDto>,
  Exact<z.infer<typeof MenuItemDtoSchema>, MenuItemDto>,
  Exact<z.infer<typeof MediaDtoSchema>, MediaDto>,
  Exact<z.infer<typeof MediaFolderDtoSchema>, MediaFolderDto>,
  Exact<z.infer<typeof LocaleAlternateSchema>, LocaleAlternate>,
  Exact<z.infer<typeof RenderPayloadSchema>, RenderPayload>,
  Exact<z.infer<typeof CatalogPluginSchema>, CatalogPlugin>,
  Exact<z.infer<typeof CatalogThemeSchema>, CatalogTheme>,
  Exact<z.infer<typeof InstalledThemeSchema>, InstalledTheme>,
  Exact<z.infer<typeof FailedJobSchema>, FailedJob>,
  Exact<z.infer<typeof FailedJobPageSchema>, FailedJobPage>,
  Exact<z.infer<typeof RegistryPackageSchema>, RegistryPackage>,
  Exact<z.infer<typeof BrowsePackageSchema>, BrowsePackage>,
  Exact<z.infer<typeof MarketplaceStatusSchema>, MarketplaceStatus>,
  Exact<z.infer<typeof SignedRevocationListSchema>, SignedRevocationList>,
  Exact<z.infer<typeof MailSettingsDtoSchema>, MailSettingsDto>,
] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true];
void _noDrift;
