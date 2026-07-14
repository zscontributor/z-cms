import { PutObjectCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  BadRequestException,
  Controller,
  Get,
  Injectable,
  Logger,
  Module,
  NotFoundException,
  Param,
  Res,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import { getSystemDb } from "@zcmsorg/database";
import { scanPackage } from "@zcmsorg/scanner";
import { ApiInternal, ApiNotFound } from "../openapi/decorators";
import { openPackage, verifyPackage, type PackageEnvelope } from "@zcmsorg/package";
import { CacheService } from "../redis/cache.service";
import type { Response } from "express";
import { Internal } from "../auth/decorators";
import { t } from "../common/i18n";

const MAX_PACKAGE_BYTES = 20 * 1024 * 1024;

/**
 * The theme a site falls back to when its own is revoked.
 *
 * It is compiled into site-runtime rather than installed as a package, which is
 * precisely why it is the safe harbour: it cannot itself be pulled.
 */
const DEFAULT_THEME_KEY = "vn.zsoft.theme.default";
const MAX_PACKAGE_LABEL = `${MAX_PACKAGE_BYTES / (1024 * 1024)}MB`;

@Injectable()
export class PackagesService {
  private readonly logger = new Logger(PackagesService.name);
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(
    private readonly config: ConfigService,
    private readonly cache: CacheService,
  ) {
    this.bucket = this.config.getOrThrow<string>("S3_BUCKET");
    this.s3 = new S3Client({
      endpoint: this.config.getOrThrow<string>("S3_ENDPOINT"),
      region: this.config.get<string>("S3_REGION") ?? "us-east-1",
      credentials: {
        accessKeyId: this.config.getOrThrow<string>("S3_ACCESS_KEY"),
        secretAccessKey: this.config.getOrThrow<string>("S3_SECRET_KEY"),
      },
      forcePathStyle: true,
    });
  }

  /**
   * Installs a package this instance downloaded from a REMOTE marketplace.
   *
   * The consumer's half of the trust model, and the mirror image of `accept()`.
   * `accept()` asks "who wrote this, and do we let it in?" — questions only the
   * marketplace can answer. Here we ask the only question a consumer can answer
   * for itself: **did the marketplace we pinned sign these exact bytes?**
   *
   * So there is no publisher lookup (the author is registered on the marketplace,
   * not here). There is `verifyPackage` against the pinned key — the same gate the
   * runtimes apply, one step earlier so a forged bundle never reaches the database.
   *
   * And there is a LOCAL re-scan. The counter-signature says "the marketplace
   * signed this", not "this is safe" — a marketplace whose review missed something,
   * or whose signing key was stolen, signs malware just as validly. Re-running the
   * static scan here, on the instance that will actually run the code, is cheap
   * defence-in-depth: a `reject` verdict (a shell, `fs`, a concatenated built-in, a
   * patched global) refuses the install outright. A `flag` is left to the
   * marketplace's own human review — re-blocking it here would reject packages a
   * reviewer already cleared — but it is logged so an operator can see it.
   *
   * The (kind, key, version) we asked for is checked against the manifest we got.
   * A marketplace that answers a request for `analytics@0.1.0` with a package
   * claiming to be something else is either broken or hostile, and either way we
   * are not writing it to disk under the name we asked for.
   */
  async installVerified(
    file: Buffer,
    expected: { kind: "theme" | "plugin"; key: string; version: string },
  ): Promise<{ key: string; version: string; checksum: string }> {
    if (file.length > MAX_PACKAGE_BYTES) {
      throw new BadRequestException(
        t()("errors.packages.tooLarge", { limit: MAX_PACKAGE_LABEL }),
      );
    }

    let pkg;
    try {
      pkg = await openPackage(file);
    } catch (err) {
      throw new BadRequestException(
        t()("errors.packages.unreadable", { reason: (err as Error).message }),
      );
    }

    const { envelope, payload } = pkg;

    // The gate. Re-hashes the payload, then checks the marketplace's signature
    // over that hash with the key pinned in THIS instance's config.
    try {
      verifyPackage(envelope, payload, this.marketplacePublicKey());
    } catch (err) {
      throw new BadRequestException(
        t()("errors.marketplace.unverified", { reason: (err as Error).message }),
      );
    }

    const manifest = envelope.manifest as Record<string, unknown>;
    if (
      manifest.kind !== expected.kind ||
      String(manifest.id) !== expected.key ||
      String(manifest.version) !== expected.version
    ) {
      throw new BadRequestException(
        t()("errors.marketplace.mismatch", {
          asked: `${expected.kind}/${expected.key}@${expected.version}`,
          got: `${String(manifest.kind)}/${String(manifest.id)}@${String(manifest.version)}`,
        }),
      );
    }

    // Local defence-in-depth scan (see the method comment). Signature-valid but
    // malicious is exactly the case a compromised or fooled marketplace produces.
    const scan = await scanPackage(file, { maxUnpackedBytes: MAX_PACKAGE_BYTES });
    if (scan.verdict === "reject") {
      const blockers = scan.findings
        .filter((f) => f.severity === "block")
        .map((f) => `${f.rule} (${f.file}${f.line ? `:${f.line}` : ""})`)
        .join(", ");
      this.logger.warn(
        `Refused ${expected.kind} ${expected.key}@${expected.version}: local scan rejected it — ${blockers}`,
      );
      throw new BadRequestException(
        t()("errors.marketplace.scanRejected", { findings: blockers }),
      );
    }
    if (scan.verdict === "flag") {
      const flags = scan.findings.map((f) => f.rule).join(", ");
      this.logger.warn(
        `Installed ${expected.kind} ${expected.key}@${expected.version} despite scan flags (already marketplace-reviewed): ${flags}`,
      );
    }

    const storageKey = `packages/${expected.kind}/${expected.key}/${expected.version}.zcms`;
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: storageKey,
        // Stored exactly as downloaded — counter-signature and all. Re-wrapping
        // would change nothing and could only lose the signature.
        Body: file,
        ContentType: "application/octet-stream",
      }),
    );

    // publisherId is null, and that is deliberate rather than lazy. A `Publisher`
    // row's `verified` flag is a claim THIS instance makes about an identity it
    // checked itself. Importing a remote marketplace's verification would let a
    // foreign "verified" travel into a table that gates our own upload endpoint.
    // The author's NAME still arrives — it is in the manifest.
    if (expected.kind === "theme") {
      await this.registerTheme(manifest, null, storageKey, envelope, envelope.marketplaceSignature ?? "", "APPROVED", null);
    } else {
      await this.registerPlugin(manifest, null, storageKey, envelope, envelope.marketplaceSignature ?? "", "APPROVED", null);
    }

    return { key: expected.key, version: expected.version, checksum: envelope.checksum };
  }

  marketplacePublicKey(): string {
    const key = (this.config.get<string>("MARKETPLACE_PUBLIC_KEY") ?? "").replace(/\\n/g, "\n");
    if (!key) {
      throw new BadRequestException(t()("errors.marketplace.noPinnedKey"));
    }
    return key;
  }

  private async registerTheme(
    manifest: Record<string, unknown>,
    publisherId: string | null,
    storageKey: string,
    envelope: PackageEnvelope,
    marketplaceSignature: string,
    reviewStatus: "APPROVED" | "QUARANTINED",
    scan: unknown,
  ) {
    const db = getSystemDb();
    const key = String(manifest.id);
    const version = String(manifest.version);
    const author = (manifest.author ?? {}) as { name?: string };

    const theme = await db.theme.upsert({
      where: { key },
      update: {
        name: String(manifest.name),
        description: (manifest.description as string) ?? null,
        publisherId,
      },
      create: {
        key,
        name: String(manifest.name),
        description: (manifest.description as string) ?? null,
        author: author.name ?? "unknown",
        publisherId,
      },
    });

    // A published version is immutable. Re-uploading the same version with
    // different bytes would silently change what every site already running it
    // executes on its next cache miss — the definition of a supply-chain attack.
    const existing = await db.themeVersion.findFirst({
      where: { themeId: theme.id, version },
    });
    if (existing && existing.checksum !== envelope.checksum) {
      throw new BadRequestException(
        t()("errors.packages.versionImmutable", { key, version }),
      );
    }

    await db.themeVersion.upsert({
      where: { themeId_version: { themeId: theme.id, version } },
      update: {},
      create: {
        themeId: theme.id,
        version,
        engine: String(manifest.engine ?? ">=0.1.0"),
        manifest: manifest as never,
        bundleUrl: storageKey,
        checksum: envelope.checksum,
        publisherSignature: envelope.publisherSignature,
        marketplaceSignature,
        reviewStatus: reviewStatus as never,
        scanReport: scan as never,
      },
    });
  }

  private async registerPlugin(
    manifest: Record<string, unknown>,
    publisherId: string | null,
    storageKey: string,
    envelope: PackageEnvelope,
    marketplaceSignature: string,
    reviewStatus: "APPROVED" | "QUARANTINED",
    scan: unknown,
  ) {
    const db = getSystemDb();
    const key = String(manifest.id);
    const version = String(manifest.version);
    const author = (manifest.author ?? {}) as { name?: string };

    const plugin = await db.plugin.upsert({
      where: { key },
      update: {
        name: String(manifest.name),
        description: (manifest.description as string) ?? null,
        publisherId,
      },
      create: {
        key,
        name: String(manifest.name),
        description: (manifest.description as string) ?? null,
        publisher: author.name ?? "unknown",
        publisherId,
      },
    });

    const existing = await db.pluginVersion.findFirst({
      where: { pluginId: plugin.id, version },
    });
    if (existing && existing.checksum !== envelope.checksum) {
      throw new BadRequestException(
        t()("errors.packages.versionImmutable", { key, version }),
      );
    }

    await db.pluginVersion.upsert({
      where: { pluginId_version: { pluginId: plugin.id, version } },
      update: {},
      create: {
        pluginId: plugin.id,
        version,
        engine: String(manifest.engine ?? ">=0.1.0"),
        manifest: manifest as never,
        permissions: (manifest.permissions ?? []) as string[],
        bundleUrl: storageKey,
        checksum: envelope.checksum,
        publisherSignature: envelope.publisherSignature,
        marketplaceSignature,
        reviewStatus: reviewStatus as never,
        scanReport: scan as never,
      },
    });
  }

  /**
   * The three effects of a revocation, with no opinion about who ordered it.
   *
   * A reviewer clicking Revoke and a signed revocation list arriving from the
   * marketplace must do the *same* thing to this instance, so they call the same
   * code. Two revocation paths would be two chances to diverge, and the one that
   * diverges is always the one nobody exercises — the remote one.
   *
   * Idempotent: a version already REJECTED with no sites left on it is a no-op
   * returning 0, which is what makes it safe to re-run on every sync.
   */
  async applyRevocation(
    kind: "theme" | "plugin",
    key: string,
    version: string,
    reason: string,
  ): Promise<number> {
    const db = getSystemDb();
    const now = new Date();
    let sitesAffected = 0;

    if (kind === "theme") {
      const row = await db.themeVersion.findFirst({
        where: { version, theme: { key } },
        select: { id: true },
      });
      if (!row) {
        throw new NotFoundException(
          t()("errors.packages.bundleNotFound", { key, version }),
        );
      }

      await db.themeVersion.update({
        where: { id: row.id },
        data: {
          reviewStatus: "REJECTED" as never,
          revokedAt: now,
          revokedReason: reason,
        },
      });

      // Deactivating without a replacement would leave the site with NO active
      // theme — a 404 for every visitor. Pulling bad code must not take the
      // customer's site down with it, so the fallback is explicit.
      const affected = await db.siteTheme.findMany({
        where: { versionId: row.id, status: "ACTIVE" },
        select: { id: true, siteId: true },
      });

      for (const install of affected) {
        await db.siteTheme.update({
          where: { id: install.id },
          data: { status: "DISABLED" as never },
        });

        // The built-in default is compiled into site-runtime and therefore cannot
        // itself be revoked — which is exactly why it is the safe harbour.
        const fallback = await db.siteTheme.findFirst({
          where: { siteId: install.siteId, theme: { key: DEFAULT_THEME_KEY } },
        });
        if (fallback) {
          await db.siteTheme.update({
            where: { id: fallback.id },
            data: { status: "ACTIVE" as never },
          });
        }
        await this.cache.invalidateSite(install.siteId);
      }
      sitesAffected = affected.length;
    } else {
      const row = await db.pluginVersion.findFirst({
        where: { version, plugin: { key } },
        select: { id: true },
      });
      if (!row) {
        throw new NotFoundException(
          t()("errors.packages.bundleNotFound", { key, version }),
        );
      }

      await db.pluginVersion.update({
        where: { id: row.id },
        data: {
          reviewStatus: "REJECTED" as never,
          revokedAt: now,
          revokedReason: reason,
        },
      });

      const affected = await db.sitePlugin.findMany({
        where: { versionId: row.id, status: "ACTIVE" },
        select: { id: true, siteId: true },
      });

      for (const install of affected) {
        // QUARANTINED, not INACTIVE: an admin must not be able to simply click
        // "activate" again on code the marketplace has pulled.
        await db.sitePlugin.update({
          where: { id: install.id },
          data: {
            status: "QUARANTINED" as never,
            lastError: `Revoked by the marketplace: ${reason}`,
          },
        });
        await this.cache.invalidateSite(install.siteId);
      }
      sitesAffected = affected.length;
    }

    await this.purgeRuntimes(kind, key, version);

    return sitesAffected;
  }

  /**
   * Tells the runtimes to forget a revoked bundle.
   *
   * Best effort, and LOUD when it fails: a runtime that never got the message
   * keeps executing the pulled code, which is the difference between a kill
   * switch and a note.
   */
  private async purgeRuntimes(
    kind: "theme" | "plugin",
    key: string,
    version: string,
  ): Promise<void> {
    // A theme purge goes to site-runtime (its render token); a plugin purge goes
    // to plugin-runtime (the privileged token). Each runtime verifies against the
    // token it was given, so the caller must match the target.
    const privileged = this.config.get<string>("CMS_INTERNAL_TOKEN") ?? "";
    const token =
      kind === "theme"
        ? (this.config.get<string>("SITE_RUNTIME_INTERNAL_TOKEN") ?? privileged)
        : privileged;

    const url =
      kind === "theme"
        ? `${this.config.get("SITE_RUNTIME_URL") ?? "http://localhost:3100"}/api/purge-package`
        : `${this.config.get("PLUGIN_RUNTIME_URL") ?? "http://localhost:4200"}/purge`;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-token": token },
        body: JSON.stringify({ key, version }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        this.logger.error(
          `Purge of ${key}@${version} rejected by ${url}: HTTP ${res.status}. ` +
            `That runtime may still be executing the revoked package.`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Purge of ${key}@${version} could not reach ${url}: ${(err as Error).message}. ` +
          `That runtime may still be executing the revoked package.`,
      );
    }
  }


  async fetchBundle(kind: string, key: string, version: string): Promise<Buffer> {
    const db = getSystemDb();

    const row =
      kind === "theme"
        ? await db.themeVersion.findFirst({
            where: { version, theme: { key } },
            select: { bundleUrl: true, reviewStatus: true },
          })
        : await db.pluginVersion.findFirst({
            where: { version, plugin: { key } },
            select: { bundleUrl: true, reviewStatus: true },
          });

    if (!row?.bundleUrl) {
      throw new NotFoundException(
        t()("errors.packages.bundleNotFound", { key, version }),
      );
    }

    // The last gate. A QUARANTINED version is signed and stored, but it must not
    // run until a human clears it — so the runtime cannot even download its
    // bytes. Enforcing it here, at the one endpoint every runtime fetches from,
    // means no install path can slip a flagged package past review.
    if (row.reviewStatus !== "APPROVED") {
      throw new NotFoundException(
        t()("errors.packages.notApproved", { key, version, status: row.reviewStatus }),
      );
    }

    const res = await this.s3.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: row.bundleUrl }),
    );
    const bytes = await res.Body!.transformToByteArray();
    return Buffer.from(bytes);
  }
}

@ApiTags("Packages")
@Controller("packages")
class PackagesController {
  constructor(private readonly packages: PackagesService) {}

  /**
   * Serves the signed package to a runtime.
   *
   * Note what this endpoint does NOT need to be trusted for. The runtime verifies
   * the marketplace signature against a public key pinned in its own config, so a
   * cms-api that has been taken over cannot serve a backdoored bundle here — it
   * would have to forge a signature it does not have the key for.
   */
  // "render": site-runtime downloads theme bundles with its render token, while
  // plugin-runtime downloads plugin bundles with the privileged token — both are
  // accepted here. The bundle is signature-pinned regardless of who fetches it.
  @Internal("render")
  @Get(":kind/:key/:version/bundle")
  @ApiOperation({
    summary: "Serve a bundle to a runtime",
    description:
      "Note what this endpoint does *not* have to be trusted for: the runtime " +
      "verifies the marketplace signature against a public key pinned in its own " +
      "config, so a cms-api that has been taken over still cannot serve a " +
      "backdoored bundle — it would have to forge a signature it has no key for. " +
      "Only APPROVED, unrevoked versions are served.",
  })
  @ApiParam({ name: "kind", enum: ["theme", "plugin"] })
  @ApiParam({ name: "key", description: 'Package key, e.g. "zsoft-seo".' })
  @ApiParam({ name: "version", description: 'Exact version, e.g. "1.2.0".' })
  @ApiInternal()
  @ApiResponse({
    status: 200,
    description: "The signed .zcms bundle.",
    content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
  })
  @ApiNotFound("No such version, or it is quarantined, rejected, or revoked.")
  async bundle(
    @Param("kind") kind: string,
    @Param("key") key: string,
    @Param("version") version: string,
    @Res() res: Response,
  ): Promise<void> {
    if (kind !== "theme" && kind !== "plugin") {
      throw new BadRequestException(t()("errors.packages.kindRequired"));
    }
    const buf = await this.packages.fetchBundle(kind, key, version);
    res.setHeader("content-type", "application/octet-stream");
    res.send(buf);
  }
}

@Module({
  controllers: [PackagesController],
  providers: [PackagesService],
  exports: [PackagesService],
})
export class PackagesModule {}
