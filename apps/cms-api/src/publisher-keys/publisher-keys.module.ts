import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Module,
  NotFoundException,
  Put,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { createPublicKey } from "node:crypto";
import { db } from "@zcmsorg/database";
import { Actor, RequirePermissions } from "../auth/decorators";
import type { RequestActor } from "../common/request-context";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { ApiAuthed, ApiZodBody, ApiZodResponse } from "../openapi/decorators";
import { PutMarketplaceTokenSchema, PutPublisherKeySchema } from "../openapi/registry";
import { MarketplaceSubmissionService } from "../theme-drafts/marketplace-submission.service";

/**
 * The author's marketplace identity — stored, never held.
 *
 * A publisher key says "I wrote this" on a package a stranger downloads. The
 * marketplace resolves the publisher FROM this key, and its own design assumes the
 * key will eventually leak ("a publisher's key ends up in a CI secret"). So this
 * server does not get to have it.
 *
 * What it stores is a blob wrapped in the author's browser under a passphrase that
 * never leaves it. Every route here moves ciphertext. The one thing that must
 * remain true, forever:
 *
 *     NOTHING IN THIS MODULE ACCEPTS, DERIVES, OR RETURNS A PRIVATE KEY.
 *
 * If a future change adds a field that carries one — for convenience, for a
 * "server-side signing option", for anything — then compromising cms-api becomes
 * enough to publish as this author, and the second defence the marketplace is
 * counting on (a real human's session) is standing alone. That is not a trade to
 * make quietly; it is a redesign.
 */

export interface PublisherKeyDto {
  /** SPKI PEM — public by definition. This is what the author registers upstream. */
  publicKeyPem: string;
  /** The sealed PKCS#8 key. Opaque here; only the author's browser can open it. */
  wrappedPrivateKey: string;
  kdfSalt: string;
  kdfIv: string;
  kdf: string;
  kdfIterations: number;
  /**
   * Whether a marketplace token is connected — never the token itself.
   *
   * The token IS readable by this server (it has to be; it authenticates the POST
   * upstream), which is exactly why it must not travel back out. A secret the API
   * hands to a browser is a secret in a browser's memory, its devtools, and any
   * script that gets onto the page. The screen only ever needs to know whether one
   * is there.
   */
  hasMarketplaceToken: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * The floor for a passphrase-derived key.
 *
 * A stolen row is an OFFLINE guessing problem, and PBKDF2-SHA256 is friendly to a
 * GPU — so the cost per guess is the only thing between a leaked database and an
 * identity. This is a floor, not a recommendation: it stops a client asking for
 * `iterations: 1`, which would make the wrapping decorative. The load-bearing
 * control is the strength of the passphrase, and that lives in the browser.
 */
export const MIN_KDF_ITERATIONS = 100_000;

export const SUPPORTED_KDFS = new Set(["PBKDF2-SHA256"]);

@ApiTags("Publisher key")
@Controller("publisher-key")
class PublisherKeysController {
  constructor(private readonly marketplace: MarketplaceSubmissionService) {}

  @Get()
  @ApiOperation({
    summary: "Read your stored publisher key",
    description:
      "Returns the wrapped key so your browser can unlock it with your passphrase. The server cannot open it.",
  })
  @ApiAuthed("theme:author")
  @ApiZodResponse("PublisherKeyDto")
  @RequirePermissions("theme:author")
  async get(@Actor() actor: RequestActor): Promise<PublisherKeyDto> {
    // Scoped to the ACTOR, not to an id in the path. There is no route here that
    // names a user: "read my key" is the only question, so "read someone else's"
    // is not a request that can be spelled.
    const row = await db().publisherKeyVault.findFirst({ where: { userId: actor.userId } });
    if (!row) throw new NotFoundException("You have no publisher key yet.");

    return {
      publicKeyPem: row.publicKeyPem,
      wrappedPrivateKey: row.wrappedPrivateKey,
      kdfSalt: row.kdfSalt,
      kdfIv: row.kdfIv,
      kdf: row.kdf,
      kdfIterations: row.kdfIterations,
      hasMarketplaceToken: Boolean(row.marketplaceToken),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  @Put()
  @ApiOperation({
    summary: "Store your publisher key",
    description:
      "Takes an already-wrapped key. The passphrase is not sent and the server has no way to unwrap it.",
  })
  @ApiAuthed("theme:author")
  @ApiZodBody("PutPublisherKeyInput")
  @ApiZodResponse("PublisherKeyDto")
  @RequirePermissions("theme:author")
  async put(
    @Actor() actor: RequestActor,
    @Body(new ZodValidationPipe(PutPublisherKeySchema))
    body: {
      publicKeyPem: string;
      wrappedPrivateKey: string;
      kdfSalt: string;
      kdfIv: string;
      kdf: string;
      kdfIterations: number;
    },
  ): Promise<PublisherKeyDto> {
    assertEd25519PublicKey(body.publicKeyPem);

    if (!SUPPORTED_KDFS.has(body.kdf)) {
      throw new BadRequestException(`Unsupported key derivation: ${body.kdf}.`);
    }
    if (body.kdfIterations < MIN_KDF_ITERATIONS) {
      throw new BadRequestException(
        `Key derivation must use at least ${MIN_KDF_ITERATIONS} iterations.`,
      );
    }

    const row = await db().publisherKeyVault.upsert({
      where: { userId: actor.userId },
      create: {
        tenantId: actor.tenantId,
        userId: actor.userId,
        publicKeyPem: body.publicKeyPem,
        wrappedPrivateKey: body.wrappedPrivateKey,
        kdfSalt: body.kdfSalt,
        kdfIv: body.kdfIv,
        kdf: body.kdf,
        kdfIterations: body.kdfIterations,
      },
      // Upsert, because re-wrapping under a new passphrase is a normal thing to do
      // and it is the same identity — same public key, new blob.
      update: {
        publicKeyPem: body.publicKeyPem,
        wrappedPrivateKey: body.wrappedPrivateKey,
        kdfSalt: body.kdfSalt,
        kdfIv: body.kdfIv,
        kdf: body.kdf,
        kdfIterations: body.kdfIterations,
      },
    });

    return {
      publicKeyPem: row.publicKeyPem,
      wrappedPrivateKey: row.wrappedPrivateKey,
      kdfSalt: row.kdfSalt,
      kdfIv: row.kdfIv,
      kdf: row.kdf,
      kdfIterations: row.kdfIterations,
      hasMarketplaceToken: Boolean(row.marketplaceToken),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * Connects this person's marketplace account to this instance.
   *
   * `theme:publish`, not `theme:author`: a token is the credential that speaks for
   * the company upstream, and handing it over is the act of granting that. Drawing
   * a theme is not.
   */
  @Put("marketplace-token")
  @ApiOperation({
    summary: "Connect a marketplace API token",
    description:
      "Stored encrypted. It is never returned — the screen only learns whether one is connected.",
  })
  @ApiAuthed("theme:publish")
  @ApiZodBody("PutMarketplaceTokenInput")
  @RequirePermissions("theme:publish")
  async putToken(
    @Actor() actor: RequestActor,
    @Body(new ZodValidationPipe(PutMarketplaceTokenSchema)) body: { token: string },
  ): Promise<{ ok: true }> {
    await this.marketplace.saveToken(actor.userId, body.token);
    return { ok: true };
  }

  @Delete("marketplace-token")
  @ApiOperation({
    summary: "Disconnect the marketplace token",
    description: "Removes it here. Revoke it at the marketplace too — this does not do that.",
  })
  @ApiAuthed("theme:publish")
  @RequirePermissions("theme:publish")
  async forgetToken(@Actor() actor: RequestActor): Promise<{ ok: true }> {
    // Deliberately does NOT revoke upstream: this instance holds a token, it does
    // not own it, and a token may be in use elsewhere. Killing it for real is a
    // decision for the developer portal, where the list of tokens lives.
    await this.marketplace.forgetToken(actor.userId);
    return { ok: true };
  }

  @Delete()
  @ApiOperation({
    summary: "Forget your publisher key",
    description:
      "Removes the stored blob. Packages you already published are unaffected — readers verify the marketplace's counter-signature, not yours.",
  })
  @ApiAuthed("theme:author")
  @RequirePermissions("theme:author")
  async remove(@Actor() actor: RequestActor): Promise<{ ok: true }> {
    await db().publisherKeyVault.deleteMany({ where: { userId: actor.userId } });
    return { ok: true };
  }
}

/**
 * Refuses anything that is not an Ed25519 public key — and, above all, refuses a
 * PRIVATE one.
 *
 * Exported for its tests. It is the one piece of judgement in this module, and the
 * consequence of getting it wrong — an author's signing key sitting in a database
 * in the clear — is not something to leave to a route test.
 *
 * The private-key check is not paranoia about types. `zcms keygen` writes two PEM
 * files side by side with names one letter apart, and somebody will eventually
 * paste the wrong one into a form labelled "your key". If that ever reached this
 * table, the author's identity would be sitting in a database in the clear, and
 * nothing would have told them. So it is caught here and named plainly, the same
 * way the marketplace's own `registerPublisher` catches it.
 */
export function assertEd25519PublicKey(pem: string): void {
  if (/PRIVATE KEY/.test(pem)) {
    throw new BadRequestException(
      "That is a PRIVATE key. Never send it anywhere — consider it burned, generate a new pair, and send the public half (the file containing 'BEGIN PUBLIC KEY').",
    );
  }
  if (!/BEGIN PUBLIC KEY/.test(pem)) {
    throw new BadRequestException("That is not a public key in PEM form.");
  }

  let key;
  try {
    key = createPublicKey(pem);
  } catch (err) {
    throw new BadRequestException(`That public key could not be read: ${(err as Error).message}`);
  }
  if (key.asymmetricKeyType !== "ed25519") {
    // The platform signs with Ed25519 and nothing else. A key of another type would
    // store fine and fail at the far end of a build, on a screen that could not say
    // why.
    throw new BadRequestException(
      `The platform signs with Ed25519; that key is ${key.asymmetricKeyType ?? "of an unknown type"}.`,
    );
  }
}

@Module({
  controllers: [PublisherKeysController],
  providers: [MarketplaceSubmissionService],
})
export class PublisherKeysModule {}
