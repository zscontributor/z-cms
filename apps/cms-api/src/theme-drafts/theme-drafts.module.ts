import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db } from "@zcmsorg/database";
import {
  readManifest,
  sha256,
  unpackTo,
  verifyChecksumSignature,
  wrap,
  type PackageEnvelope,
  type PackageManifest,
} from "@zcmsorg/package";
import {
  LayoutDocumentSchema,
  MAX_THEME_COLLECTIONS,
  collectDocumentCollections,
  getWidgetSpec,
  type LayoutDocument,
  type LayoutNode,
} from "@zcmsorg/schemas";
import { Actor, RequirePermissions, SiteId, SiteScoped } from "../auth/decorators";
import type { RequestActor } from "../common/request-context";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import {
  ApiAuthed,
  ApiSiteScoped,
  ApiZodBody,
  ApiZodResponse,
} from "../openapi/decorators";
import {
  CreateThemeDraftSchema,
  SealThemeDraftSchema,
  UpdateThemeDraftSchema,
} from "../openapi/registry";
import { QueueService } from "../queue/queue.module";
import { MarketplaceSubmissionService } from "./marketplace-submission.service";

/**
 * Theme drafts — the GUI Theme Editor's storage.
 *
 * A draft is a DRAWING: the LayoutDocument a person built by dragging widgets onto
 * a canvas. This module does nothing but hold it. It generates no code, signs
 * nothing, and installs nothing — those are the build and submit paths, and they
 * are deliberately not here, because they are the steps that turn data into
 * something a runtime executes and they answer to different permissions.
 *
 * What this module DOES owe the rest of the system is that a stored document is a
 * VALID one. Everything downstream — the code generator, the manifest builder, the
 * widget library — reads this column and assumes its shape. So every write goes
 * through LayoutDocumentSchema, and nothing else in the pipeline re-validates it.
 * The fence is here.
 */

export interface ThemeDraftDto {
  id: string;
  siteId: string;
  name: string;
  key: string;
  version: string;
  description: string | null;
  document: LayoutDocument;
  status: "DRAFT" | "BUILDING" | "BUILT" | "SUBMITTED" | "FAILED";
  buildError: string | null;
  lastBuiltAt: string | null;
  submittedAt: string | null;
  submissionRef: string | null;
  /**
   * The digest the author signs, set by the last build. Null when there is nothing
   * staged — which is also the editor's signal that Sign has nothing to act on.
   */
  payloadChecksum: string | null;
  author: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A draft as the list screen shows it — everything except the document.
 *
 * A LayoutDocument is the whole drawing: every node, every prop, every binding. A
 * list of ten drafts that each carried one would be megabytes to render a table of
 * names, and the editor already fetches the document it is about to open.
 */
export interface ThemeDraftSummaryDto {
  id: string;
  siteId: string;
  name: string;
  key: string;
  version: string;
  description: string | null;
  status: ThemeDraftDto["status"];
  buildError: string | null;
  lastBuiltAt: string | null;
  submittedAt: string | null;
  author: { id: string; name: string } | null;
  updatedAt: string;
}

/**
 * Reverse-DNS, like every other package id in the platform.
 *
 * Checked here so the editor can say "that is not a key" while somebody is typing
 * it, rather than at the end of a build. It is NOT the security boundary: the
 * sideload and marketplace paths independently refuse `vn.zsoft.` and any key a
 * built-in or marketplace theme already holds (assertNotImpersonating), and they
 * do it against the DB at the moment of registration, which is the only moment the
 * answer is true. A check here would be a check against a stale world.
 */
const KEY_RE = /^[a-z0-9]+(\.[a-z0-9-]+){2,}$/;

type DraftRow = Awaited<ReturnType<typeof loadDraft>>;

function loadDraft(id: string, siteId: string) {
  return db().themeDraft.findFirst({
    where: { id, siteId },
    include: { author: { select: { id: true, name: true } } },
  });
}

function toDto(row: NonNullable<DraftRow>): ThemeDraftDto {
  return {
    id: row.id,
    siteId: row.siteId,
    name: row.name,
    key: row.key,
    version: row.version,
    description: row.description,
    // Parsed rather than cast. The column is JSONB and Prisma types it as
    // `JsonValue`; a row written by an older build (or by a hand-run UPDATE) is
    // not automatically the shape this build's schema describes.
    document: LayoutDocumentSchema.parse(row.document),
    status: row.status,
    buildError: row.buildError,
    lastBuiltAt: row.lastBuiltAt?.toISOString() ?? null,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    submissionRef: row.submissionRef,
    payloadChecksum: row.payloadChecksum,
    author: row.author ? { id: row.author.id, name: row.author.name } : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toSummary(row: NonNullable<DraftRow>): ThemeDraftSummaryDto {
  return {
    id: row.id,
    siteId: row.siteId,
    name: row.name,
    key: row.key,
    version: row.version,
    description: row.description,
    status: row.status,
    buildError: row.buildError,
    lastBuiltAt: row.lastBuiltAt?.toISOString() ?? null,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    author: row.author ? { id: row.author.id, name: row.author.name } : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Reads the theme.json out of a packed payload, through the hardened reader.
 *
 * `unpackTo` is the same reader the scanner uses: no symlinks, no traversal, no
 * bombs. The payload here is one this instance built moments ago, so it is not
 * hostile — but "not hostile" is a property of today's code path, and the reader
 * that assumes it is the one that gets reused later on bytes that are.
 */
async function manifestFromPayload(payload: Buffer): Promise<PackageManifest> {
  const staging = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "zcms-seal-"));
  try {
    await unpackTo(payload, staging);
    return readManifest(staging, "theme");
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** A drawing with nothing on it — one empty section, ready to drop a widget into. */
function emptyDocument(): LayoutDocument {
  const node = (id: string, kind: LayoutNode["kind"], children?: LayoutNode[]): LayoutNode => ({
    id,
    kind,
    props: {},
    ...(children ? { children } : {}),
  });
  return LayoutDocumentSchema.parse({
    version: 1,
    tokens: {},
    templates: {
      page: [node("s1", "section", [node("r1", "row", [node("c1", "column", [])])])],
    },
  });
}

/**
 * Reads the payload the build job staged.
 *
 * A separate object rather than a method on ThemeDraftsService because it is the
 * only thing in this module that talks to storage, and keeping it apart is what
 * lets the interesting logic — the budget checks, the signature gate — be tested
 * without an S3.
 */
@Injectable()
export class StagedPayloadStore {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(config: ConfigService) {
    this.bucket = config.getOrThrow<string>("S3_BUCKET");
    this.s3 = new S3Client({
      endpoint: config.getOrThrow<string>("S3_ENDPOINT"),
      region: config.get<string>("S3_REGION") ?? "us-east-1",
      credentials: {
        accessKeyId: config.getOrThrow<string>("S3_ACCESS_KEY"),
        secretAccessKey: config.getOrThrow<string>("S3_SECRET_KEY"),
      },
      forcePathStyle: true,
    });
  }

  async read(ref: string): Promise<Buffer> {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: ref }));
    const bytes = await res.Body?.transformToByteArray();
    if (!bytes?.length) throw new ConflictException("The staged build is gone. Build it again.");
    return Buffer.from(bytes);
  }
}

@Injectable()
export class ThemeDraftsService {
  /**
   * Validates a document beyond its schema: the budgets and the vocabulary.
   *
   * The schema says the tree is well-formed. It cannot say that cms-api will
   * actually RUN all nine of the collection queries this drawing declares (it caps
   * at eight and silently drops the rest — see RenderService), nor that every
   * widget type in it is one the widget library can draw. Both of those are
   * silently-empty-page bugs on a live site, and both are cheap to refuse here.
   */
  assertRenderable(document: LayoutDocument): void {
    const collections = collectDocumentCollections(document);
    const count = Object.keys(collections).length;
    if (count > MAX_THEME_COLLECTIONS) {
      throw new BadRequestException(
        `This design asks for ${count} content lists; a theme may declare ${MAX_THEME_COLLECTIONS}. ` +
          `Two lists showing the same type, count and order share one query — the rest must go.`,
      );
    }

    const unknown = new Set<string>();
    const trees = Object.values(document.templates).filter(Array.isArray) as LayoutNode[][];
    for (const tree of trees) {
      const stack: LayoutNode[] = [...tree];
      while (stack.length > 0) {
        const n = stack.pop()!;
        if (n.kind === "widget" && n.widgetType && !getWidgetSpec(n.widgetType)) {
          unknown.add(n.widgetType);
        }
        for (const child of n.children ?? []) stack.push(child);
      }
    }
    if (unknown.size > 0) {
      // Refused rather than dropped. The renderer skips an unknown widget so an
      // OLD runtime survives a NEW document — but a document being written right
      // now, on this build, naming a widget this build has never heard of is a bug
      // in the client, and storing it would hide it until somebody's page renders
      // a hole.
      throw new BadRequestException(
        `This design uses widgets this version does not know: ${[...unknown].sort().join(", ")}.`,
      );
    }
  }
}

@ApiTags("Theme drafts")
@ApiSiteScoped()
@Controller("theme-drafts")
@SiteScoped()
class ThemeDraftsController {
  constructor(
    private readonly service: ThemeDraftsService,
    private readonly queue: QueueService,
    private readonly staging: StagedPayloadStore,
    private readonly marketplace: MarketplaceSubmissionService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "List theme drafts",
    description: "Every design drawn for this site. Without the documents — see GET /theme-drafts/:id.",
  })
  @ApiAuthed("theme:author")
  @ApiZodResponse("ThemeDraftSummaryDto", { isArray: true })
  @RequirePermissions("theme:author")
  async list(@SiteId() siteId: string): Promise<ThemeDraftSummaryDto[]> {
    const rows = await db().themeDraft.findMany({
      where: { siteId },
      include: { author: { select: { id: true, name: true } } },
      orderBy: { updatedAt: "desc" },
    });
    return rows.map(toSummary);
  }

  @Get(":id")
  @ApiOperation({ summary: "Read a theme draft", description: "The design, with its full document." })
  @ApiParam({ name: "id", description: "Draft id." })
  @ApiAuthed("theme:author")
  @ApiZodResponse("ThemeDraftDto")
  @RequirePermissions("theme:author")
  async get(@SiteId() siteId: string, @Param("id") id: string): Promise<ThemeDraftDto> {
    const row = await loadDraft(id, siteId);
    if (!row) throw new NotFoundException("Draft not found.");
    return toDto(row);
  }

  @Post()
  @ApiOperation({
    summary: "Create a theme draft",
    description: "Starts a new design — an empty page template, ready to draw on.",
  })
  @ApiAuthed("theme:author")
  @ApiZodBody("CreateThemeDraftInput")
  @ApiZodResponse("ThemeDraftDto")
  @RequirePermissions("theme:author")
  async create(
    @Actor() actor: RequestActor,
    @SiteId() siteId: string,
    @Body(new ZodValidationPipe(CreateThemeDraftSchema))
    body: { name: string; key: string; description?: string },
  ): Promise<ThemeDraftDto> {
    if (!KEY_RE.test(body.key)) {
      throw new BadRequestException(
        'A theme key is reverse-DNS, e.g. "com.acme.theme.shop".',
      );
    }

    // The unique index is on (tenant_id, key) and is the real guard — this check
    // exists to turn a 500-shaped constraint violation into a sentence the author
    // can act on. Both are needed: a race between two creates lands on the index.
    const clash = await db().themeDraft.findFirst({
      where: { tenantId: actor.tenantId, key: body.key },
      select: { id: true },
    });
    if (clash) throw new ConflictException(`A draft already claims the key "${body.key}".`);

    const row = await db().themeDraft.create({
      data: {
        tenantId: actor.tenantId,
        siteId,
        authorId: actor.userId,
        name: body.name,
        key: body.key,
        description: body.description ?? null,
        // `as never`, as everywhere else a typed object goes into a JSONB column
        // (see contents.service.ts): Prisma's InputJsonValue is an index-signature
        // type, and an interface with optional properties is not assignable to one.
        document: emptyDocument() as never,
      },
      include: { author: { select: { id: true, name: true } } },
    });
    return toDto(row);
  }

  @Patch(":id")
  @ApiOperation({
    summary: "Update a theme draft",
    description:
      "Saves the design. The document is validated in full on every write — this column is what the code generator later turns into a signed package.",
  })
  @ApiParam({ name: "id", description: "Draft id." })
  @ApiAuthed("theme:author")
  @ApiZodBody("UpdateThemeDraftInput")
  @ApiZodResponse("ThemeDraftDto")
  @RequirePermissions("theme:author")
  async update(
    @SiteId() siteId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateThemeDraftSchema))
    body: {
      name?: string;
      description?: string;
      version?: string;
      document?: LayoutDocument;
    },
  ): Promise<ThemeDraftDto> {
    const existing = await loadDraft(id, siteId);
    if (!existing) throw new NotFoundException("Draft not found.");

    // A build reads the document while it runs. Letting a save land mid-build would
    // sign a package that matches neither the drawing before nor the one after.
    if (existing.status === "BUILDING") {
      throw new ConflictException("This design is being built. Wait for it to finish.");
    }

    if (body.document) this.service.assertRenderable(body.document);

    const row = await db().themeDraft.update({
      where: { id: existing.id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.version !== undefined ? { version: body.version } : {}),
        // ANY edit drops the staged build — not just a document change.
        //
        // The staged payload contains a theme.json built from the name, version and
        // description too, and its checksum is what the author signs. Renaming the
        // theme after a build and then signing would produce a package whose
        // envelope says one thing and whose payload says another; keeping the
        // staging alive across an edit is how that ships.
        //
        // Back to DRAFT, so the editor asks for a build before it offers to sign.
        status: "DRAFT" as const,
        buildError: null,
        payloadChecksum: null,
        payloadRef: null,
        ...(body.document ? { document: body.document as never } : {}),
      },
      include: { author: { select: { id: true, name: true } } },
    });
    return toDto(row);
  }

  /**
   * Turns the drawing into a built, signed package.
   *
   * `theme:sideload`, NOT `theme:author`. Drawing is a document in this tenant's
   * database; building is the step that produces code the runtime will import, and
   * a drawn theme is installed through exactly the same unreviewed-code door as a
   * file somebody uploaded. The person who may move a widget is not automatically
   * the person who may put unreviewed code on the server — that is the whole reason
   * the two permissions are separate.
   */
  @Post(":id/build")
  @ApiOperation({
    summary: "Build a theme draft",
    description:
      "Generates code from the design, bundles it, and signs it with the operator key. Runs in the background — poll the draft for status.",
  })
  @ApiParam({ name: "id", description: "Draft id." })
  @ApiAuthed("theme:sideload")
  @RequirePermissions("theme:sideload")
  async build(
    @Actor() actor: RequestActor,
    @SiteId() siteId: string,
    @Param("id") id: string,
  ): Promise<{ status: "BUILDING" }> {
    const existing = await loadDraft(id, siteId);
    if (!existing) throw new NotFoundException("Draft not found.");
    if (existing.status === "BUILDING") {
      throw new ConflictException("This design is already being built.");
    }

    // Validated before the job is queued, so an author gets the reason NOW rather
    // than finding a FAILED badge later and having to guess.
    this.service.assertRenderable(LayoutDocumentSchema.parse(existing.document));

    // BUILDING is claimed here, not by the worker: the flag is what refuses a
    // second Build press, and a flag the worker sets is a flag that is not set yet
    // while somebody is pressing the button again.
    await db().themeDraft.update({
      where: { id: existing.id },
      data: { status: "BUILDING", buildError: null },
    });

    // `jobId` keyed on the draft: BullMQ refuses a duplicate while one is queued,
    // so a double-click cannot start two builds racing to write the same S3 key.
    await this.queue.enqueue(
      "theme.build",
      { tenantId: actor.tenantId, siteId, draftId: existing.id, actorId: actor.userId },
      { jobId: `theme-build-${existing.id}` },
    );

    return { status: "BUILDING" };
  }

  /**
   * Turns the author's signature into a finished .zcms.
   *
   * The half of publishing that happens on the server. The other half — the
   * signature itself — happened in the author's browser, because `signChecksum`
   * signs 64 bytes and a browser can do that. The private key is not here, was
   * never here, and this endpoint has no field to put one in.
   *
   * What the server does contribute is refusal: it re-verifies the signature it was
   * handed against the checksum it staged. A client is not trusted to have signed
   * the right thing, or to have signed at all — submitting a package whose
   * signature does not verify would waste a marketplace review slot and tell the
   * author nothing useful.
   */
  @Post(":id/seal")
  @HttpCode(200)
  @ApiOperation({
    summary: "Seal a signed package",
    description:
      "Takes the author's signature over the staged payload's checksum and returns the finished .zcms. The private key stays in the browser.",
  })
  @ApiParam({ name: "id", description: "Draft id." })
  @ApiAuthed("theme:author")
  @ApiZodBody("SealThemeDraftInput")
  @RequirePermissions("theme:author")
  async seal(
    @SiteId() siteId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SealThemeDraftSchema))
    body: { signature: string; publicKeyPem: string },
  ): Promise<{ filename: string; base64: string }> {
    const draft = await loadDraft(id, siteId);
    if (!draft) throw new NotFoundException("Draft not found.");

    const { file, filename } = await this.buildSignedPackage(draft, body);

    // JSON + base64, not an octet-stream.
    //
    // A .zcms is binary, and every other response in this admin travels through one
    // apiFetch that reads the body as text — handing it bytes would corrupt them
    // silently. Base64 costs a third more over the wire for a file measured in
    // hundreds of kilobytes, which is the cheaper mistake to make.
    return { filename, base64: file.toString("base64") };
  }

  /**
   * Seals the package and sends it to the marketplace for review.
   *
   * `theme:publish`, not `theme:author`: this is the step that puts the company's
   * name on a package a stranger downloads, and once the marketplace counter-signs
   * an approved package there is no recalling it.
   *
   * The signature still comes from the browser. This endpoint holds a token, which
   * is enough to SUBMIT and not enough to SIGN — so compromising this server yields
   * the ability to re-send something the author already signed, and nothing more.
   */
  @Post(":id/submit")
  @HttpCode(200)
  @ApiOperation({
    summary: "Submit a signed theme to the marketplace",
    description:
      "Seals the author's signature into a .zcms and sends it for review. Needs a connected marketplace API token.",
  })
  @ApiParam({ name: "id", description: "Draft id." })
  @ApiAuthed("theme:publish")
  @ApiZodBody("SealThemeDraftInput")
  @RequirePermissions("theme:publish")
  async submit(
    @Actor() actor: RequestActor,
    @SiteId() siteId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SealThemeDraftSchema))
    body: { signature: string; publicKeyPem: string },
  ): Promise<{ id: string; version: string; reviewStatus: string }> {
    const draft = await loadDraft(id, siteId);
    if (!draft) throw new NotFoundException("Draft not found.");

    const { file, filename } = await this.buildSignedPackage(draft, body);
    const result = await this.marketplace.submit(actor.userId, file, filename);

    await db().themeDraft.update({
      where: { id: draft.id },
      data: {
        status: "SUBMITTED",
        submittedAt: new Date(),
        // The marketplace's own id for the submission, so the editor can say more
        // than "sent" — and so a support conversation has a number in it.
        submissionRef: result.id ?? null,
      },
    });

    return result;
  }

  /**
   * Turns the author's signature into a finished .zcms.
   *
   * Shared by seal and submit deliberately. They differ only in where the bytes go
   * afterwards; if each assembled its own package, the two would drift, and the one
   * that forgot a check is the one somebody would use.
   */
  private async buildSignedPackage(
    draft: NonNullable<DraftRow>,
    body: { signature: string; publicKeyPem: string },
  ): Promise<{ file: Buffer; filename: string }> {
    if (!draft.payloadChecksum || !draft.payloadRef) {
      throw new ConflictException("Build this design before signing it.");
    }

    // THE gate. `verifyChecksumSignature` is the same function the marketplace runs
    // on the far side, so a signature that passes here is one that will pass there —
    // and a mistake (wrong key, wrong passphrase, stale checksum) is caught now,
    // with a sentence, instead of as a rejection days later.
    if (!verifyChecksumSignature(draft.payloadChecksum, body.signature, body.publicKeyPem)) {
      throw new BadRequestException(
        "That signature does not match this build. If you re-built the design after signing, sign it again.",
      );
    }

    const payload = await this.staging.read(draft.payloadRef);
    // Re-hashed rather than trusted: the checksum column says what was signed, and
    // the bytes about to be wrapped must be those bytes. A staging object swapped
    // underneath would otherwise ship a payload the signature does not cover.
    if (sha256(payload) !== draft.payloadChecksum) {
      throw new ConflictException("The staged build no longer matches. Build the design again.");
    }

    const envelope: PackageEnvelope = {
      checksum: draft.payloadChecksum,
      // Read out of the PAYLOAD, not rebuilt from the draft row.
      //
      // The envelope's manifest is a claim about the bytes underneath it, and the
      // only way it cannot lie is to come from them. Deriving it from the draft
      // again would let a name edited after the build travel in the envelope while
      // the payload's own theme.json said something else — a package that disagrees
      // with itself, signed.
      manifest: await manifestFromPayload(payload),
      publisherSignature: body.signature,
      // Trimmed for the same reason buildPackage trims it: a PEM read from a file
      // ends in a newline, the same PEM in a database usually does not, and the
      // marketplace compares them byte-for-byte.
      publisherKey: body.publicKeyPem.trim(),
    };

    return {
      file: await wrap(envelope, payload),
      filename: `${draft.key}-${draft.version}.zcms`,
    };
  }

  @Delete(":id")
  @ApiOperation({
    summary: "Delete a theme draft",
    description: "Removes the design. Any theme already built and installed from it is untouched.",
  })
  @ApiParam({ name: "id", description: "Draft id." })
  @ApiAuthed("theme:author")
  @RequirePermissions("theme:author")
  async remove(@SiteId() siteId: string, @Param("id") id: string): Promise<{ ok: true }> {
    const existing = await loadDraft(id, siteId);
    if (!existing) throw new NotFoundException("Draft not found.");
    if (existing.status === "BUILDING") {
      throw new ConflictException("This design is being built. Wait for it to finish.");
    }
    // Only the drawing goes. A ThemeVersion built from it is a signed package that
    // sites may be running — deleting a draft must not be a way to pull a live
    // theme out from under them. Uninstalling is the sideload path's job.
    await db().themeDraft.delete({ where: { id: existing.id } });
    return { ok: true };
  }
}

@Module({
  controllers: [ThemeDraftsController],
  providers: [ThemeDraftsService, StagedPayloadStore, MarketplaceSubmissionService],
  exports: [ThemeDraftsService],
})
export class ThemeDraftsModule {}
