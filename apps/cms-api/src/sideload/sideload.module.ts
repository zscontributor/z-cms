import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  HttpCode,
  Injectable,
  Logger,
  Module,
  NotFoundException,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getSystemDb } from "@zcmsorg/database";
import {
  buildPackage,
  looksLikeZip,
  openPackage,
  unzipToDir,
  verifyOperator,
  PackageError,
  type PackageErrorCode,
  type PackageEnvelope,
} from "@zcmsorg/package";
import { scanPackage, type ScanReport } from "@zcmsorg/scanner";
import { Actor, Internal, RequirePermissions } from "../auth/decorators";
import type { RequestActor } from "../common/request-context";
import { t } from "../common/i18n";
import { ApiAuthed, ApiFileUpload, ApiNotFound } from "../openapi/decorators";
import { PackagesModule, PackagesService } from "../packages/packages.module";

const MAX_PACKAGE_BYTES = 20 * 1024 * 1024;
const MAX_PACKAGE_LABEL = `${MAX_PACKAGE_BYTES / (1024 * 1024)}MB`;

/**
 * The reverse-DNS namespace of this platform's own first-party packages. A sideload
 * may not claim an id under it: those names belong to Z-SOFT, and letting an operator
 * mint `vn.zsoft.theme.anything` locally is the first half of a confusion attack —
 * the second half is a runtime that treats the name as first-party. Refused by name
 * here, and independently refused by origin below; a string check is never the only
 * check.
 */
const RESERVED_ID_PREFIX = "vn.zsoft.";

type Kind = "theme" | "plugin";

function operatorVerificationReason(error: unknown): string {
  if (!(error instanceof PackageError)) return (error as Error).message;

  const keys = {
    operator_key_missing: "errors.sideload.operatorKeyMissing",
    operator_checksum_mismatch: "errors.sideload.operatorChecksumMismatch",
    operator_signature_missing: "errors.sideload.operatorSignatureMissing",
    operator_signature_invalid: "errors.sideload.operatorSignatureInvalid",
  } satisfies Record<PackageErrorCode, string>;
  const key = error.code ? keys[error.code] : undefined;

  return key ? t()(key) : error.message;
}

/**
 * Sideloading — installing a theme or plugin FROM A FILE, without the marketplace.
 *
 * This is the escape hatch for a self-hosted, possibly air-gapped instance whose
 * operator writes their own code and takes responsibility for it. It is deliberately
 * kept apart from `PackagesService.installVerified` (the marketplace path), whose
 * every line assumes a marketplace counter-signature and a completed human review.
 * A sideload has neither, so it earns neither's shortcuts:
 *
 *   - it is verified against the OPERATOR key, not the marketplace key;
 *   - it is recorded with origin=SIDELOAD, so it never leaks into the marketplace
 *     catalogue and the admin can show it apart as unverified;
 *   - it lands QUARANTINED regardless of the scan verdict, so a human must approve
 *     it before any runtime can fetch it — the "consent" is a durable, audited act,
 *     not a dialog;
 *   - it may not take a name that belongs to a built-in or a marketplace package.
 *
 * The runtime is still the final authority: it re-verifies every bundle against a key
 * pinned in its OWN config before importing, so nothing here can make a runtime run
 * code it cannot itself vouch for.
 */
@Injectable()
export class SideloadService {
  private readonly logger = new Logger(SideloadService.name);
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(
    private readonly config: ConfigService,
    private readonly packages: PackagesService,
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
   * The pinned operator public key — the ONLY key a sideload is verified against.
   *
   * Empty means this instance never opted into sideloading, and every attempt is
   * refused here rather than reaching `verifyOperator` (which would refuse it too).
   */
  private operatorPublicKey(): string {
    const key = (this.config.get<string>("OPERATOR_PUBLIC_KEY") ?? "").replace(
      /\\n/g,
      "\n",
    );
    if (!key) {
      throw new BadRequestException(t()("errors.sideload.notEnabled"));
    }
    return key;
  }

  /**
   * The operator PRIVATE key — present only on instances that opted into the .zip
   * convenience path, where cms-api packs and signs on the operator's behalf.
   *
   * This is the trade-off the operator chose knowingly: holding a key that runtimes
   * trust means compromising cms-api becomes code execution in site-runtime, a
   * boundary the offline-signing path (no private key here) keeps intact. Absent
   * means only pre-signed .zcms files are accepted, and this refuses the zip.
   */
  private operatorPrivateKey(): string {
    const key = (this.config.get<string>("OPERATOR_PRIVATE_KEY") ?? "").replace(
      /\\n/g,
      "\n",
    );
    if (!key) {
      throw new BadRequestException(t()("errors.sideload.zipNotEnabled"));
    }
    return key;
  }

  /**
   * Themes run UNSANDBOXED inside site-runtime, so sideloading one is remote code
   * execution in the process that renders every page. That is gated behind an env
   * flag the operator must set on purpose — a permission alone is not enough, because
   * the risk is of a different kind than "install a reviewed theme". Plugins run in
   * an isolate with no ambient authority, so they need no second gate.
   */
  private assertKindAllowed(kind: Kind): void {
    if (kind !== "theme") return;
    const flag = (this.config.get<string>("ALLOW_THEME_SIDELOAD") ?? "").toLowerCase();
    if (flag !== "true" && flag !== "1") {
      throw new ForbiddenException(t()("errors.sideload.themeDisabled"));
    }
  }

  /**
   * `by` rather than a RequestActor: the only thing this needs from the caller is
   * who to credit in the audit log, and the caller is not always a request. The
   * Theme Editor's build job installs through this same path from the worker, where
   * there is no session — a synthetic RequestActor would be a lie the type system
   * could not see, and this is honest about needing exactly two fields.
   */
  async installSideload(
    by: { tenantId: string; actorId: string },
    kind: Kind,
    file: Express.Multer.File,
  ): Promise<{ key: string; version: string; reviewStatus: string; scan: ScanReport }> {
    this.assertKindAllowed(kind);
    const pinned = this.operatorPublicKey();

    const bytes = file?.buffer;
    if (!bytes?.length) {
      throw new BadRequestException(t()("errors.packages.unreadable", { reason: "empty file" }));
    }
    if (bytes.length > MAX_PACKAGE_BYTES) {
      throw new BadRequestException(
        t()("errors.packages.tooLarge", { limit: MAX_PACKAGE_LABEL }),
      );
    }

    // Two accepted shapes, one common gate below. A pre-signed .zcms (gzip) is used
    // as-is. A raw .zip (PK\x03\x04) is unpacked, packed and signed here — but only
    // if the operator private key is configured — and the result then goes through
    // the very same verifyOperator/scan path, so the server-signed route earns no
    // shortcut over the offline-signed one.
    const zcms = looksLikeZip(bytes) ? await this.packFromZip(kind, bytes) : bytes;

    let pkg;
    try {
      pkg = await openPackage(zcms);
    } catch (err) {
      throw new BadRequestException(
        t()("errors.packages.unreadable", { reason: (err as Error).message }),
      );
    }
    const { envelope, payload } = pkg;

    // THE GATE. Verified against the operator key pinned in THIS process's config,
    // on the operator trust route — never the marketplace key, and with no fallback
    // to it. A package lacking a valid operator signature is refused, full stop.
    try {
      verifyOperator(envelope, payload, pinned);
    } catch (err) {
      throw new BadRequestException(
        t()("errors.sideload.unverified", { reason: operatorVerificationReason(err) }),
      );
    }

    const manifest = envelope.manifest as Record<string, unknown>;
    if (manifest.kind !== kind) {
      throw new BadRequestException(
        t()("errors.sideload.kindMismatch", {
          asked: kind,
          got: String(manifest.kind),
        }),
      );
    }
    const key = String(manifest.id);
    const version = String(manifest.version);

    await this.assertNotImpersonating(kind, key);

    // Static scan, and STRICTER than the marketplace path: there, a `flag` is waved
    // through because a human already reviewed the package. A sideload has had no
    // such review, so `reject` refuses it outright and everything else lands
    // QUARANTINED — the operator becomes that human, explicitly, at approve time.
    const scan = await scanPackage(zcms, { maxUnpackedBytes: MAX_PACKAGE_BYTES });
    if (scan.verdict === "reject") {
      const blockers = scan.findings
        .filter((f) => f.severity === "block")
        .map((f) => `${f.rule} (${f.file}${f.line ? `:${f.line}` : ""})`)
        .join(", ");
      throw new BadRequestException(
        t()("errors.sideload.scanRejected", { findings: blockers }),
      );
    }

    const storageKey = `packages/${kind}/${key}/${version}.zcms`;
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: storageKey,
        Body: zcms,
        ContentType: "application/octet-stream",
      }),
    );

    await this.registerSideload(kind, manifest, envelope, storageKey, scan);

    await getSystemDb().auditLog.create({
      data: {
        tenantId: by.tenantId,
        actorId: by.actorId,
        action: "sideload.installed",
        resourceType: kind,
        resourceId: key,
        metadata: { version, verdict: scan.verdict } as never,
      },
    });

    this.logger.log(
      `Sideloaded ${kind} ${key}@${version} (scan: ${scan.verdict}) — QUARANTINED, awaiting approval`,
    );
    return { key, version, reviewStatus: "QUARANTINED", scan };
  }

  /**
   * Turns a raw .zip the operator uploaded into a signed .zcms — the server-sign path.
   *
   * The zip is opened by the HARDENED reader (`unzipToDir`: no symlinks, no traversal,
   * no bombs, files forced to 0644), into a throwaway temp dir. `buildPackage` then
   * reads the manifest, packs ONLY the allow-listed distributable files (dropping any
   * key material, source or node_modules that rode along), and signs the result with
   * the operator key — as both publisher and operator, since a sideload speaks only
   * for itself. What comes back is an ordinary .zcms that the caller runs through the
   * same verifyOperator + scan gate as a pre-signed upload; the scan therefore sees
   * exactly the bytes that will be stored and imported, not the raw upload.
   */
  private async packFromZip(kind: Kind, zip: Buffer): Promise<Buffer> {
    const operatorPrivate = this.operatorPrivateKey();
    const operatorPublic = this.operatorPublicKey();

    const staging = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "zcms-sideload-"),
    );
    try {
      await unzipToDir(zip, staging);
      const { file } = await buildPackage(staging, kind, operatorPrivate, operatorPublic, {
        operatorPrivateKey: operatorPrivate,
      });
      return file;
    } catch (err) {
      throw new BadRequestException(
        t()("errors.sideload.zipUnreadable", { reason: (err as Error).message }),
      );
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  /**
   * Refuses a sideload whose id belongs to someone else.
   *
   * Two independent checks, because a name is cheap to fake:
   *   - the reserved reverse-DNS prefix (a string check), and
   *   - the database state: a key already present as a built-in (`isCore`) or as a
   *     marketplace version. Upserting over either would let a local file rewrite the
   *     metadata of platform-controlled or reviewed code — and, for the built-in
   *     default theme, quietly displace the safe-harbour every revocation falls back
   *     to. The DB check is the load-bearing one; the prefix is defence in depth.
   */
  private async assertNotImpersonating(kind: Kind, key: string): Promise<void> {
    if (key.startsWith(RESERVED_ID_PREFIX)) {
      throw new ForbiddenException(
        t()("errors.sideload.reservedNamespace", { key, prefix: RESERVED_ID_PREFIX }),
      );
    }

    const db = getSystemDb();
    if (kind === "theme") {
      const theme = await db.theme.findUnique({
        where: { key },
        select: { isCore: true, versions: { select: { origin: true }, take: 50 } },
      });
      if (theme?.isCore || theme?.versions.some((v) => v.origin === "MARKETPLACE")) {
        throw new ForbiddenException(t()("errors.sideload.keyTaken", { key }));
      }
    } else {
      const plugin = await db.plugin.findUnique({
        where: { key },
        select: { isCore: true, versions: { select: { origin: true }, take: 50 } },
      });
      if (plugin?.isCore || plugin?.versions.some((v) => v.origin === "MARKETPLACE")) {
        throw new ForbiddenException(t()("errors.sideload.keyTaken", { key }));
      }
    }
  }

  /**
   * Writes the catalogue rows for a sideload — a SEPARATE path from the marketplace
   * `registerTheme/registerPlugin`, on purpose.
   *
   * It forces the platform-controlled columns to safe values a manifest must never
   * choose: `origin=SIDELOAD`, `isCore=false`, `reviewStatus=QUARANTINED`,
   * `publisherId=null`. And it refuses to overwrite an existing non-sideload row,
   * so even past the impersonation guard a key belonging to a built-in or marketplace
   * package cannot be rewritten here.
   */
  private async registerSideload(
    kind: Kind,
    manifest: Record<string, unknown>,
    envelope: PackageEnvelope,
    storageKey: string,
    scan: ScanReport,
  ): Promise<void> {
    const db = getSystemDb();
    const key = String(manifest.id);
    const version = String(manifest.version);
    const author = (manifest.author ?? {}) as { name?: string };

    if (kind === "theme") {
      const existing = await db.theme.findUnique({
        where: { key },
        select: { id: true, isCore: true, versions: { select: { origin: true }, take: 50 } },
      });
      if (existing && (existing.isCore || existing.versions.some((v) => v.origin !== "SIDELOAD"))) {
        throw new ForbiddenException(t()("errors.sideload.keyTaken", { key }));
      }

      const theme = await db.theme.upsert({
        where: { key },
        update: { name: String(manifest.name), description: (manifest.description as string) ?? null },
        create: {
          key,
          name: String(manifest.name),
          description: (manifest.description as string) ?? null,
          author: author.name ?? "unknown",
          // Never isCore, never a publisher: a sideload speaks only for itself.
          isCore: false,
          publisherId: null,
        },
      });

      const prior = await db.themeVersion.findFirst({ where: { themeId: theme.id, version } });
      if (prior && prior.checksum !== envelope.checksum) {
        throw new BadRequestException(t()("errors.packages.versionImmutable", { key, version }));
      }

      await db.themeVersion.upsert({
        where: { themeId_version: { themeId: theme.id, version } },
        update: {},
        create: {
          themeId: theme.id,
          version,
          engine: String(manifest.engine ?? ">=0.1.0"),
          manifest: manifest as never,
          origin: "SIDELOAD" as never,
          bundleUrl: storageKey,
          checksum: envelope.checksum,
          publisherSignature: envelope.publisherSignature,
          // No marketplaceSignature: this never went through the marketplace.
          reviewStatus: "QUARANTINED" as never,
          scanReport: scan as never,
        },
      });
    } else {
      const existing = await db.plugin.findUnique({
        where: { key },
        select: { id: true, isCore: true, versions: { select: { origin: true }, take: 50 } },
      });
      if (existing && (existing.isCore || existing.versions.some((v) => v.origin !== "SIDELOAD"))) {
        throw new ForbiddenException(t()("errors.sideload.keyTaken", { key }));
      }

      const plugin = await db.plugin.upsert({
        where: { key },
        update: { name: String(manifest.name), description: (manifest.description as string) ?? null },
        create: {
          key,
          name: String(manifest.name),
          description: (manifest.description as string) ?? null,
          publisher: author.name ?? "unknown",
          isCore: false,
          publisherId: null,
        },
      });

      const prior = await db.pluginVersion.findFirst({ where: { pluginId: plugin.id, version } });
      if (prior && prior.checksum !== envelope.checksum) {
        throw new BadRequestException(t()("errors.packages.versionImmutable", { key, version }));
      }

      await db.pluginVersion.upsert({
        where: { pluginId_version: { pluginId: plugin.id, version } },
        update: {},
        create: {
          pluginId: plugin.id,
          version,
          engine: String(manifest.engine ?? ">=0.1.0"),
          manifest: manifest as never,
          origin: "SIDELOAD" as never,
          permissions: (manifest.permissions ?? []) as string[],
          bundleUrl: storageKey,
          checksum: envelope.checksum,
          publisherSignature: envelope.publisherSignature,
          reviewStatus: "QUARANTINED" as never,
          scanReport: scan as never,
        },
      });
    }
  }

  /**
   * Approves a QUARANTINED sideload — the operator being the reviewer they are on a
   * self-hosted instance. Only ever acts on origin=SIDELOAD; a marketplace or
   * built-in version cannot be flipped to APPROVED through this door.
   */
  async approveSideload(
    actor: RequestActor,
    kind: Kind,
    key: string,
    version: string,
  ): Promise<{ ok: true }> {
    const db = getSystemDb();
    const row = await this.findSideloadVersion(kind, key, version);

    if (kind === "theme") {
      await db.themeVersion.update({ where: { id: row.id }, data: { reviewStatus: "APPROVED" as never } });
    } else {
      await db.pluginVersion.update({ where: { id: row.id }, data: { reviewStatus: "APPROVED" as never } });
    }

    await db.auditLog.create({
      data: {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "sideload.approved",
        resourceType: kind,
        resourceId: key,
        metadata: { version } as never,
      },
    });
    this.logger.log(`Approved sideload ${kind} ${key}@${version}`);
    return { ok: true };
  }

  /**
   * Uninstalls a sideload: reject-and-fall-back (reusing the tested revocation kill
   * switch), then delete the rows and the stored bytes so the code is actually gone.
   *
   * Guarded to origin=SIDELOAD at every step: this endpoint can never delete a
   * built-in or a marketplace package, whatever key it is handed.
   */
  async removeSideload(
    actor: RequestActor,
    kind: Kind,
    key: string,
    version: string,
  ): Promise<{ ok: true }> {
    const db = getSystemDb();
    const row = await this.findSideloadVersion(kind, key, version);

    // Reuse the marketplace kill switch: disables active installs, falls themed
    // sites back to the compiled-in default, purges the runtime caches. It sets the
    // version REJECTED, which we are about to delete outright — the point of calling
    // it is the fallback + purge, not the status.
    await this.packages.applyRevocation(kind, key, version, "operator uninstall");

    if (kind === "theme") {
      // The install rows reference the version with an onDelete: Restrict FK, so they
      // go first. applyRevocation already moved affected sites onto the fallback.
      await db.siteTheme.deleteMany({ where: { versionId: row.id } });
      await db.themeVersion.delete({ where: { id: row.id } });
      const remaining = await db.themeVersion.count({ where: { themeId: row.parentId } });
      if (remaining === 0) await db.theme.delete({ where: { id: row.parentId } });
    } else {
      await db.sitePlugin.deleteMany({ where: { versionId: row.id } });
      await db.pluginVersion.delete({ where: { id: row.id } });
      const remaining = await db.pluginVersion.count({ where: { pluginId: row.parentId } });
      if (remaining === 0) await db.plugin.delete({ where: { id: row.parentId } });
    }

    if (row.bundleUrl) {
      await this.s3
        .send(new DeleteObjectCommand({ Bucket: this.bucket, Key: row.bundleUrl }))
        .catch((err) =>
          // The rows are already gone; a leaked object is storage litter, not a
          // security hole (fetchBundle has nothing to point at it). Log, don't fail.
          this.logger.warn(`Sideload ${key}@${version} S3 object left behind: ${(err as Error).message}`),
        );
    }

    await db.auditLog.create({
      data: {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "sideload.removed",
        resourceType: kind,
        resourceId: key,
        metadata: { version } as never,
      },
    });
    this.logger.log(`Removed sideload ${kind} ${key}@${version}`);
    return { ok: true };
  }

  /**
   * Finds a version and PROVES it is a sideload before anything mutates it. A version
   * of some other origin, or none at all, throws here — so approve and remove can
   * never touch a built-in or marketplace package.
   */
  private async findSideloadVersion(
    kind: Kind,
    key: string,
    version: string,
  ): Promise<{ id: string; parentId: string; origin: string; bundleUrl: string | null }> {
    const db = getSystemDb();
    const row =
      kind === "theme"
        ? await db.themeVersion.findFirst({
            where: { version, theme: { key } },
            select: { id: true, themeId: true, origin: true, bundleUrl: true },
          })
        : await db.pluginVersion.findFirst({
            where: { version, plugin: { key } },
            select: { id: true, pluginId: true, origin: true, bundleUrl: true },
          });

    if (!row) {
      throw new NotFoundException(t()("errors.packages.bundleNotFound", { key, version }));
    }
    if (row.origin !== "SIDELOAD") {
      throw new ForbiddenException(t()("errors.sideload.notSideload", { key, version }));
    }
    const parentId = "themeId" in row ? row.themeId : row.pluginId;
    return { id: row.id, parentId, origin: row.origin, bundleUrl: row.bundleUrl };
  }
}

@ApiTags("Sideload")
@Controller("sideload")
class SideloadController {
  constructor(private readonly sideload: SideloadService) {}

  /**
   * Install a package the WORKER built — the Theme Editor's build job.
   *
   * Internal-token guarded because the body names any tenant it likes, exactly like
   * `/mail/deliver`: only our own worker may say "install this, on behalf of that
   * tenant". A user-facing route with the same power would be a way to install a
   * theme into somebody else's tenant.
   *
   * It deliberately earns NO shortcut. The bytes go through the same
   * verifyOperator + assertNotImpersonating + scan + registerSideload path as a file
   * an operator uploaded by hand, and land QUARANTINED like anything else. A drawn
   * theme is built from a constant wrapper and a reviewed widget library, so it is
   * tempting to trust it — but the runtime's rule is not "trust safe-looking code",
   * it is "import nothing a key pinned in my own env did not sign". A second, softer
   * door is always the one that eventually gets used.
   *
   * ALLOW_THEME_SIDELOAD still applies (via assertKindAllowed). A drawn theme is
   * still unsandboxed code in site-runtime, and that switch is precisely the
   * operator's answer to "may themes nobody reviewed run here".
   */
  @Internal()
  @Post("internal/built")
  @HttpCode(200)
  @ApiOperation({
    summary: "Install a package built by the worker",
    description:
      "Called by the theme.build job, never by a user. The package goes through the " +
      "same verify/scan/quarantine gate as a hand-uploaded sideload.",
  })
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_PACKAGE_BYTES } }))
  installBuilt(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { tenantId?: string; actorId?: string; kind?: string },
  ) {
    const tenantId = body.tenantId?.trim();
    const actorId = body.actorId?.trim();
    if (!tenantId || !actorId) {
      throw new BadRequestException("tenantId and actorId are required.");
    }
    // Only themes are drawn. Accepting `kind` from the body and passing it through
    // would make this a general "install anything, as any tenant" endpoint the day
    // somebody adds a second job.
    if (body.kind && body.kind !== "theme") {
      throw new BadRequestException("Only themes are built from a design.");
    }
    return this.sideload.installSideload({ tenantId, actorId }, "theme", file);
  }

  /**
   * Two routes rather than one with a `kind` field, so the permission guard is
   * static — theme:sideload versus plugin:sideload — the same reasoning as the
   * marketplace install routes. A permission checked in a method body is one someone
   * will forget.
   */
  @Post("theme")
  @HttpCode(200)
  @ApiOperation({
    summary: "Install a theme from a signed .zcms file",
    description:
      "Verifies the file against the pinned OPERATOR key, scans it, and stores it " +
      "QUARANTINED — it will not render until approved. Requires ALLOW_THEME_SIDELOAD, " +
      "because a theme runs unsandboxed in site-runtime.",
  })
  @ApiAuthed("theme:sideload")
  @ApiFileUpload("A signed .zcms theme package, or a .zip if OPERATOR_PRIVATE_KEY is set.")
  @RequirePermissions("theme:sideload")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_PACKAGE_BYTES } }))
  installTheme(@Actor() actor: RequestActor, @UploadedFile() file: Express.Multer.File) {
    return this.sideload.installSideload(
      { tenantId: actor.tenantId, actorId: actor.userId },
      "theme",
      file,
    );
  }

  @Post("plugin")
  @HttpCode(200)
  @ApiOperation({
    summary: "Install a plugin from a signed .zcms file",
    description:
      "Verifies against the pinned OPERATOR key, scans, and stores QUARANTINED until " +
      "approved. The plugin still runs in the isolate with only the permissions an " +
      "admin later grants it at install time.",
  })
  @ApiAuthed("plugin:sideload")
  @ApiFileUpload("A signed .zcms plugin package, or a .zip if OPERATOR_PRIVATE_KEY is set.")
  @RequirePermissions("plugin:sideload")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_PACKAGE_BYTES } }))
  installPlugin(@Actor() actor: RequestActor, @UploadedFile() file: Express.Multer.File) {
    return this.sideload.installSideload(
      { tenantId: actor.tenantId, actorId: actor.userId },
      "plugin",
      file,
    );
  }

  @Post(":kind/:key/:version/approve")
  @HttpCode(200)
  @ApiOperation({
    summary: "Approve a quarantined sideload so runtimes may fetch it",
    description: "Only acts on origin=SIDELOAD; a marketplace or built-in version cannot be approved here.",
  })
  @ApiParam({ name: "kind", enum: ["theme", "plugin"] })
  @ApiParam({ name: "key" })
  @ApiParam({ name: "version" })
  @ApiAuthed("theme:sideload", "plugin:sideload")
  @ApiNotFound("No such sideloaded version.")
  @RequirePermissions("theme:sideload", "plugin:sideload")
  approve(
    @Actor() actor: RequestActor,
    @Param("kind") kind: string,
    @Param("key") key: string,
    @Param("version") version: string,
  ) {
    return this.sideload.approveSideload(actor, this.assertKind(kind), key, version);
  }

  @Delete(":kind/:key/:version")
  @HttpCode(200)
  @ApiOperation({
    summary: "Uninstall a sideloaded package",
    description:
      "Falls active sites back to safety, purges the runtimes, then deletes the rows " +
      "and stored bytes. Refuses anything that is not origin=SIDELOAD.",
  })
  @ApiParam({ name: "kind", enum: ["theme", "plugin"] })
  @ApiParam({ name: "key" })
  @ApiParam({ name: "version" })
  @ApiAuthed("theme:sideload", "plugin:sideload")
  @ApiNotFound("No such sideloaded version.")
  @RequirePermissions("theme:sideload", "plugin:sideload")
  remove(
    @Actor() actor: RequestActor,
    @Param("kind") kind: string,
    @Param("key") key: string,
    @Param("version") version: string,
  ) {
    return this.sideload.removeSideload(actor, this.assertKind(kind), key, version);
  }

  private assertKind(kind: string): Kind {
    if (kind !== "theme" && kind !== "plugin") {
      throw new BadRequestException(t()("errors.packages.kindRequired"));
    }
    return kind;
  }
}

@Module({
  imports: [PackagesModule],
  controllers: [SideloadController],
  providers: [SideloadService],
  exports: [SideloadService],
})
export class SideloadModule {}
