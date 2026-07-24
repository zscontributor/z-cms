import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { db } from "@zcmsorg/database";
import { decryptSecret, encryptSecret, readKey } from "../common/secret-box";

/**
 * The one outbound call that speaks AS a developer.
 *
 * Every other request this instance makes to the marketplace is an anonymous read
 * of a public registry — the trust boundary there is a pinned key, not a
 * credential. This one is different: it puts a person's name on a package a
 * stranger will download, so it carries their token.
 *
 * What it does NOT carry is their signing key. The package arriving here is already
 * signed, in the author's browser, before this service ever sees it. That split is
 * the point:
 *
 *   this server holds  the token — enough to SUBMIT, not enough to SIGN
 *   the author holds   the key   — enough to SIGN, not enough to SUBMIT
 *
 * The marketplace's `accept()` needs both: it resolves the publisher from the key
 * that signed the package, and checks that the developer submitting owns that
 * publisher. So compromising this server yields the ability to re-send a package
 * the author already signed, and nothing more. Its own code says why that matters
 * ("keys leak: a publisher's key ends up in a CI secret") — this is the arrangement
 * that keeps the two secrets apart.
 */
@Injectable()
export class MarketplaceSubmissionService {
  private readonly logger = new Logger(MarketplaceSubmissionService.name);

  constructor(private readonly config: ConfigService) {}

  /** The marketplace this instance publishes to. Null when unconfigured. */
  private remote(): string | null {
    const url = (this.config.get<string>("MARKETPLACE_URL") ?? "").trim().replace(/\/$/, "");
    return url.length > 0 ? url : null;
  }

  private key(): Buffer {
    return readKey(
      this.config.get<string>("MARKETPLACE_TOKEN_ENCRYPTION_KEY"),
      "MARKETPLACE_TOKEN_ENCRYPTION_KEY",
    );
  }

  /** True when this person has connected a marketplace account to this instance. */
  async hasToken(userId: string): Promise<boolean> {
    const row = await db().publisherKeyVault.findFirst({
      where: { userId },
      select: { marketplaceToken: true },
    });
    return Boolean(row?.marketplaceToken);
  }

  /**
   * Stores the token, encrypted.
   *
   * Refuses anything that is not shaped like one. A person pasting a session cookie
   * or half a token here would otherwise learn about it from a 401 days later, in a
   * place that could not explain it.
   */
  async saveToken(userId: string, token: string): Promise<void> {
    const trimmed = token.trim();
    if (!trimmed.startsWith("zcms_pat_")) {
      throw new BadRequestException(
        'That does not look like a marketplace API token. It starts with "zcms_pat_" and is created under Tokens in the developer portal.',
      );
    }

    const vault = await db().publisherKeyVault.findFirst({
      where: { userId },
      select: { id: true },
    });
    if (!vault) {
      // The token is stored beside the key, and the key comes first: there is no
      // point holding a credential to submit with when there is nothing to sign.
      throw new BadRequestException("Create your publisher key before connecting a token.");
    }

    await db().publisherKeyVault.update({
      where: { id: vault.id },
      data: { marketplaceToken: encryptSecret(trimmed, this.key()) },
    });
  }

  async forgetToken(userId: string): Promise<void> {
    await db().publisherKeyVault.updateMany({
      where: { userId },
      data: { marketplaceToken: null },
    });
  }

  /**
   * Sends a signed package for review.
   *
   * The far side does the deciding — it re-hashes the payload, verifies the
   * publisher signature against the key IN ITS OWN DATABASE, checks the version
   * moves forward, scans the bytes, and puts the result in a queue a human reads.
   * Nothing here is trusted there, which is exactly why this can be so short.
   */
  async submit(
    userId: string,
    file: Buffer,
    filename: string,
  ): Promise<{ id: string; version: string; reviewStatus: string }> {
    const remote = this.remote();
    if (!remote) throw new BadRequestException("No marketplace is configured on this instance.");

    const row = await db().publisherKeyVault.findFirst({
      where: { userId },
      select: { marketplaceToken: true },
    });
    if (!row?.marketplaceToken) {
      throw new BadRequestException(
        "Connect a marketplace API token before publishing. Create one under Tokens in the developer portal.",
      );
    }

    const token = decryptSecret(row.marketplaceToken, this.key());

    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(file)]), filename);

    // The URL is built from operator config and a constant path — never from
    // anything a caller sent. The same rule the install path follows, and the reason
    // there is no SSRF here to find.
    const res = await fetch(`${remote}/api/v1/developer/submissions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: form,
      // The far side unpacks and scans a 20MB archive inside this request.
      signal: AbortSignal.timeout(60_000),
    });

    const text = await res.text();
    if (!res.ok) {
      // The marketplace's message is the useful one — "version must move forward",
      // "that key belongs to another publisher", "10 submissions per hour". Passing
      // it through is the difference between an author fixing it and filing a
      // ticket. The token is not in it; it never appears in a response.
      this.logger.warn(`Marketplace refused a submission (${res.status})`);
      throw new BadRequestException(
        `The marketplace refused this package: ${safeMessage(text, res.status)}`,
      );
    }

    return JSON.parse(text);
  }
}

/** Pulls a human sentence out of the far side's JSON, or falls back to the status. */
function safeMessage(text: string, status: number): string {
  try {
    const body = JSON.parse(text) as { message?: unknown };
    if (typeof body.message === "string") return body.message;
    if (Array.isArray(body.message)) return body.message.join(", ");
  } catch {
    /* not JSON — fall through */
  }
  return `HTTP ${status}`;
}
