import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Injectable,
  Logger,
  Module,
  NotFoundException,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from "@nestjs/swagger";
import { getSystemDb } from "@zcmsorg/database";
import { verifyRevocationList, RevocationError } from "@zcmsorg/package";
import { Actor, Internal, RequirePermissions } from "../auth/decorators";
import { SecurityEventService } from "../audit/security-event.service";
import { t } from "../common/i18n";
import type { RequestActor } from "../common/request-context";
import { ApiAuthed, ApiInternal, ApiNotFound, ApiZodResponse } from "../openapi/decorators";
import { PackagesModule, PackagesService } from "../packages/packages.module";

/**
 * The consumer face of the marketplace.
 *
 * This instance is a SHOPPER, never a shop. It browses a remote registry
 * (`MARKETPLACE_URL`, e.g. `marketplace.z-cms.org`), pulls signed packages into
 * its own catalogue, and enforces the marketplace's signed revocation feed. The
 * registry/operator half — publishing, counter-signing, review, serving the
 * catalogue — lives in a separate, private Z-SOFT service and is deliberately
 * NOT part of this open-source build.
 *
 * **The trust boundary is a pinned key, not a hostname.** "Who do I install
 * from" is `MARKETPLACE_URL` (operator config, never a request), and every byte
 * that lands is verified against `MARKETPLACE_PUBLIC_KEY` before it is written —
 * so a marketplace that has been taken over still cannot make this instance hold,
 * let alone run, a package it did not sign.
 */

/** After this long without a successful sync, the revocation data is called stale. */
const STALE_AFTER_HOURS = 24;

/** A package as the remote registry describes it. Consumed, never served. */
export interface RegistryPackage {
  kind: "theme" | "plugin";
  key: string;
  name: string;
  description: string | null;
  author: string;
  publisher: { slug: string; name: string; verified: boolean } | null;
  latestVersion: string;
  versions: string[];
  permissions: string[];
  /**
   * Screenshot URLs, ABSOLUTE by the time they reach anyone here.
   *
   * The registry hands them out relative to its own root, because behind a proxy
   * it cannot know its public origin. This instance can: `MARKETPLACE_URL` is
   * exactly where it fetched the catalogue from. `fetchRegistry` joins them, so
   * nothing downstream — not the controller, not the admin — has to know that the
   * wire format was relative.
   */
  screenshots: string[];
  /** External video URL (YouTube, Vimeo, …), or null. Never a packaged file. */
  video: string | null;
  updatedAt: string;
}

export interface BrowsePackage extends RegistryPackage {
  /** Already in this instance's catalogue. */
  installed: boolean;
  /** The version this instance holds, if any — so the UI can offer an update. */
  installedVersion: string | null;
}

export interface MarketplaceStatus {
  /** Where this instance shops. Null when misconfigured (no MARKETPLACE_URL). */
  url: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  revokedCount: number;
  /**
   * True when the last accepted revocation list is older than STALE_AFTER_HOURS.
   * This is the field the whole fail-open design rests on. See `sync()`.
   */
  stale: boolean;
}

@Injectable()
export class MarketplaceService {
  private readonly logger = new Logger(MarketplaceService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly packages: PackagesService,
    private readonly events: SecurityEventService,
  ) {}

  /** The marketplace this instance shops at. Null when unconfigured. */
  private remote(): string | null {
    const url = (this.config.get<string>("MARKETPLACE_URL") ?? "").trim().replace(/\/$/, "");
    return url.length > 0 ? url : null;
  }

  // -------------------------------------------------------------------------
  // Browsing and installing — what this instance consumes
  // -------------------------------------------------------------------------

  /** The remote catalogue, annotated with what we already hold. */
  async browse(kind?: string, q?: string): Promise<BrowsePackage[]> {
    const remote = this.remote();
    if (!remote) {
      throw new BadRequestException(t()("errors.marketplace.notConfigured"));
    }
    const catalogue = await this.fetchRegistry(remote, kind, q);

    const db = getSystemDb();
    const [themes, plugins] = await Promise.all([
      db.theme.findMany({
        select: { key: true, versions: { select: { version: true }, orderBy: { createdAt: "desc" }, take: 1 } },
      }),
      db.plugin.findMany({
        select: { key: true, versions: { select: { version: true }, orderBy: { createdAt: "desc" }, take: 1 } },
      }),
    ]);

    const held = new Map<string, string | null>();
    for (const row of themes) held.set(`theme:${row.key}`, row.versions[0]?.version ?? null);
    for (const row of plugins) held.set(`plugin:${row.key}`, row.versions[0]?.version ?? null);

    return catalogue.map((pkg) => {
      const id = `${pkg.kind}:${pkg.key}`;
      return {
        ...pkg,
        installed: held.has(id),
        installedVersion: held.get(id) ?? null,
      };
    });
  }

  private async fetchRegistry(
    remote: string,
    kind?: string,
    q?: string,
  ): Promise<RegistryPackage[]> {
    const url = new URL(`${remote}/api/v1/registry/packages`);
    if (kind) url.searchParams.set("kind", kind);
    if (q) url.searchParams.set("q", q);

    let res: globalThis.Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    } catch (err) {
      throw new BadRequestException(
        t()("errors.marketplace.unreachable", { url: remote, reason: (err as Error).message }),
      );
    }
    if (!res.ok) {
      throw new BadRequestException(
        t()("errors.marketplace.unreachable", { url: remote, reason: `HTTP ${res.status}` }),
      );
    }
    const packages = (await res.json()) as RegistryPackage[];

    // Made absolute HERE, once, against the marketplace this instance is
    // configured to shop at — never against anything in the response. A registry
    // that could hand back an absolute URL could point the admin's <img> at any
    // host it liked, which is how a compromised marketplace turns a catalogue page
    // into a beacon.
    return packages.map((pkg) => ({
      ...pkg,
      screenshots: (pkg.screenshots ?? [])
        .filter((path) => typeof path === "string" && path.startsWith("/"))
        .map((path) => `${remote}${path}`),
      video: typeof pkg.video === "string" ? pkg.video : null,
    }));
  }

  /**
   * Pulls a package into this instance's catalogue.
   *
   * Note what the caller does NOT get to say: a URL. The request names a package
   * — kind, key, version — and the URL it is fetched from comes from this
   * instance's own configuration. A tenant-supplied download URL would turn
   * "install a theme" into a request forgery primitive pointed at whatever the
   * API server can reach, which on most deployments includes the metadata service.
   *
   * What lands in the database is verified against the PINNED key before it is
   * written (`installVerified`), so a marketplace that has been taken over cannot
   * make this instance hold — let alone run — a package it did not sign.
   *
   * Only the platform catalogue is touched. Putting the package ON a site is the
   * existing `POST /plugins/:key/install` (which is where the permission consent
   * screen lives) or `POST /themes/:key/activate`. Downloading is not consenting.
   */
  async install(
    actor: RequestActor,
    kind: "theme" | "plugin",
    key: string,
    version: string,
  ): Promise<{ ok: true; kind: string; key: string; version: string }> {
    const remote = this.remote();
    if (!remote) {
      throw new BadRequestException(t()("errors.marketplace.notConfigured"));
    }
    const source = `${remote}/api/v1/registry/bundle/${kind}/${encodeURIComponent(key)}/${encodeURIComponent(version)}`;

    let res: globalThis.Response;
    try {
      res = await fetch(source, { signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      throw new BadRequestException(
        t()("errors.marketplace.unreachable", { url: remote, reason: (err as Error).message }),
      );
    }
    if (!res.ok) {
      throw new NotFoundException(
        t()("errors.marketplace.bundleNotFound", { key, version, status: String(res.status) }),
      );
    }
    const bundle = Buffer.from(await res.arrayBuffer());

    await this.packages.installVerified(bundle, { kind, key, version });

    await getSystemDb().auditLog.create({
      data: {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "marketplace.installed",
        resourceType: kind,
        resourceId: key,
        metadata: { version, source: remote } as never,
      },
    });

    this.logger.log(`Installed ${kind} ${key}@${version} from ${remote}`);
    return { ok: true, kind, key, version };
  }

  // -------------------------------------------------------------------------
  // Revocation sync — the only channel that reaches code already installed
  // -------------------------------------------------------------------------

  async status(): Promise<MarketplaceStatus> {
    const row = await getSystemDb().marketplaceSync.findUnique({ where: { id: "singleton" } });
    const stale =
      !row?.lastSyncedAt ||
      Date.now() - row.lastSyncedAt.getTime() > STALE_AFTER_HOURS * 3600_000;

    return {
      url: this.remote(),
      lastSyncedAt: row?.lastSyncedAt?.toISOString() ?? null,
      lastError: row?.lastError ?? null,
      revokedCount: row?.revokedCount ?? 0,
      // An instance that has never synced is stale, not fresh. "I have never
      // asked" must never render as "there is nothing to report".
      stale: Boolean(this.remote()) && stale,
    };
  }

  /**
   * Pulls the signed revocation list and enforces it locally.
   *
   * **This is fail-open, and that is a decision, not an oversight.** If the
   * marketplace is unreachable we keep serving what we have. The alternative —
   * refusing to load community packages when the marketplace is down — hands
   * every customer's site to its uptime, and a CMS that goes dark because a
   * marketplace had a bad afternoon is a worse product than one that runs a
   * revoked plugin for another hour. Every plugin ecosystem at scale makes the
   * same call.
   *
   * The residual risk is real and worth stating plainly: **an attacker who can
   * keep an instance off the network can delay a revocation indefinitely.** What
   * we refuse to do is let that happen quietly — every failure is recorded, the
   * age of the last good answer is surfaced in the admin, and `stale` is what an
   * operator sees when the channel has been silent for a day.
   *
   * Enforcement is additive: nothing here un-revokes. A replayed old list
   * therefore cannot resurrect pulled code, and a list older than the newest one
   * we accepted is refused outright as a rollback.
   */
  async sync(): Promise<{ ok: boolean; applied: number; error?: string }> {
    const db = getSystemDb();
    const remote = this.remote();
    const now = new Date();

    if (!remote) return { ok: true, applied: 0 };

    const record = async (data: Record<string, unknown>) => {
      await db.marketplaceSync.upsert({
        where: { id: "singleton" },
        update: data as never,
        create: { id: "singleton", ...data } as never,
      });
    };

    const state = await db.marketplaceSync.findUnique({ where: { id: "singleton" } });

    let doc: unknown;
    try {
      const res = await fetch(`${remote}/api/v1/registry/revocations`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      doc = await res.json();
    } catch (err) {
      const error = `Could not reach ${remote}: ${(err as Error).message}`;
      this.logger.warn(`${error}. Keeping the last accepted list; revocation data is going stale.`);
      await record({ lastAttemptAt: now, lastError: error });
      return { ok: false, applied: 0, error };
    }

    let list;
    try {
      list = verifyRevocationList(
        doc,
        this.packages.marketplacePublicKey(),
        state?.lastIssuedAt ?? undefined,
      );
    } catch (err) {
      const error = (err as Error).message;

      // A list that fails verification is not a network problem, it is someone
      // trying to talk to us in the marketplace's voice. Alert, do not merely log.
      this.events.record("marketplace.revocation_rejected", {
        url: remote,
        reason: error,
        forged: err instanceof RevocationError,
      });
      this.logger.error(`Refused the revocation list from ${remote}: ${error}`);
      await record({ lastAttemptAt: now, lastError: error });
      return { ok: false, applied: 0, error };
    }

    let applied = 0;
    for (const entry of list.revoked) {
      // Only what we actually hold. The marketplace's list is the whole world's;
      // most of it is about packages this instance has never heard of.
      const have =
        entry.kind === "theme"
          ? await db.themeVersion.findFirst({
              where: { version: entry.version, theme: { key: entry.key }, revokedAt: null },
              select: { id: true },
            })
          : await db.pluginVersion.findFirst({
              where: { version: entry.version, plugin: { key: entry.key }, revokedAt: null },
              select: { id: true },
            });
      if (!have) continue;

      const sitesAffected = await this.packages.applyRevocation(
        entry.kind,
        entry.key,
        entry.version,
        entry.reason || "Revoked by the marketplace.",
      );
      applied += 1;

      this.events.record("package.revoked", {
        kind: entry.kind,
        packageId: entry.key,
        version: entry.version,
        reason: entry.reason,
        sitesAffected,
        source: remote,
      });
      this.logger.warn(
        `Marketplace revoked ${entry.kind} ${entry.key}@${entry.version} — ` +
          `${sitesAffected} site(s) moved off it. Reason: ${entry.reason}`,
      );
    }

    await record({
      lastAttemptAt: now,
      lastSyncedAt: now,
      lastIssuedAt: new Date(list.issuedAt),
      lastError: null,
      revokedCount: list.revoked.length,
    });

    return { ok: true, applied };
  }
}

/** The consumer face. Requires a session: this spends the instance's disk and trust. */
@ApiTags("Marketplace")
@Controller("marketplace")
class MarketplaceController {
  constructor(private readonly marketplace: MarketplaceService) {}

  @Get("browse")
  @ApiOperation({
    summary: "Browse the marketplace",
    description:
      "The remote catalogue (MARKETPLACE_URL), annotated with what this instance " +
      "already holds.",
  })
  @ApiAuthed("theme:read")
  @ApiQuery({ name: "kind", required: false, enum: ["theme", "plugin"] })
  @ApiQuery({ name: "q", required: false, description: "Substring of the name or key." })
  @ApiZodResponse("BrowsePackage", { isArray: true })
  @RequirePermissions("theme:read")
  async browse(@Query("kind") kind?: string, @Query("q") q?: string): Promise<BrowsePackage[]> {
    if (kind && kind !== "theme" && kind !== "plugin") {
      throw new BadRequestException(t()("errors.packages.kindRequired"));
    }
    return this.marketplace.browse(kind, q);
  }

  @Get("status")
  @ApiOperation({
    summary: "Where this instance shops, and when it last heard from there",
    description:
      "`stale` is the field that matters. Revocation sync is fail-open, so an " +
      "instance that cannot reach the marketplace keeps running what it has — " +
      "which means the age of the last good answer is a security signal, not a " +
      "diagnostic.",
  })
  @ApiAuthed("theme:read")
  @ApiZodResponse("MarketplaceStatus")
  @RequirePermissions("theme:read")
  async status(): Promise<MarketplaceStatus> {
    return this.marketplace.status();
  }

  /**
   * Two routes rather than one with a `kind` field, so the permission guard is
   * static: pulling a theme needs `theme:install`, pulling a plugin needs
   * `plugin:install`. A single route would have to check that itself, and a
   * permission checked in a method body is a permission someone will forget.
   */
  @Post("install/theme/:key/:version")
  @HttpCode(200)
  @ApiOperation({
    summary: "Pull a theme into this instance's catalogue",
    description:
      "Fetches the signed bundle from the remote marketplace and verifies it " +
      "against the pinned key before storing it. A version already held is a no-op.",
  })
  @ApiParam({ name: "key", description: 'Package key, e.g. "vn.zsoft.theme.default".' })
  @ApiParam({ name: "version", description: 'Exact version, e.g. "1.2.0".' })
  @ApiAuthed("theme:install")
  @ApiZodResponse("MarketplaceInstalled", { description: "In this instance's catalogue; activate it separately." })
  @ApiNotFound("The marketplace does not serve that version.")
  @RequirePermissions("theme:install")
  async installTheme(
    @Actor() actor: RequestActor,
    @Param("key") key: string,
    @Param("version") version: string,
  ) {
    return this.marketplace.install(actor, "theme", key, version);
  }

  @Post("install/plugin/:key/:version")
  @HttpCode(200)
  @ApiOperation({
    summary: "Pull a plugin into this instance's catalogue",
    description:
      "Downloads and verifies. It does NOT put the plugin on a site and grants it " +
      "nothing — that is POST /plugins/:key/install, where the permission consent " +
      "screen lives. Downloading is not consenting.",
  })
  @ApiParam({ name: "key", description: 'Package key, e.g. "vn.zsoft.plugin.seo".' })
  @ApiParam({ name: "version", description: 'Exact version, e.g. "1.2.0".' })
  @ApiAuthed("plugin:install")
  @ApiZodResponse("MarketplaceInstalled", { description: "Downloaded and verified. Not installed on any site yet." })
  @ApiNotFound("The marketplace does not serve that version.")
  @RequirePermissions("plugin:install")
  async installPlugin(
    @Actor() actor: RequestActor,
    @Param("key") key: string,
    @Param("version") version: string,
  ) {
    return this.marketplace.install(actor, "plugin", key, version);
  }

  /** The worker's hourly tick. Internal: it is not a user action. */
  @Internal()
  @Post("sync")
  @HttpCode(200)
  @ApiOperation({
    summary: "Pull and enforce the signed revocation list",
    description:
      "Called by the worker on a schedule. This is the only channel that reaches " +
      "a package already installed and running.",
  })
  @ApiInternal()
  @ApiZodResponse("MarketplaceSync", {
    description:
      "Fails open: `ok: false` with an `error` means the list could not be fetched, " +
      "and the instance keeps running what it has. Watch `stale` on /marketplace/status.",
  })
  async sync() {
    return this.marketplace.sync();
  }
}

@Module({
  imports: [PackagesModule],
  controllers: [MarketplaceController],
  providers: [MarketplaceService],
  exports: [MarketplaceService],
})
export class MarketplaceModule {}
