import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { db, getSystemDb } from "@zcmsorg/database";
import type { MailSettings, MailSettingsDto } from "@zcmsorg/schemas";
import { decryptSecret, encryptSecret, readKey } from "../common/secret-box";

/**
 * A site's mail configuration, resolved and decrypted.
 *
 * Never leaves the API process. The DTO is what the admin screen sees; this is
 * what the SMTP client sees, and the difference between them is the password.
 */
export interface ResolvedMailConfig {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string } | null;
  from: { name: string; address: string };
  replyTo: string | null;
}

/** `SMTP_FROM="Z-CMS <no-reply@z-cms.org>"` — the form everyone writes it in. */
function parseFrom(raw: string): { name: string; address: string } | null {
  const angled = /^\s*(.*?)\s*<\s*([^>]+?)\s*>\s*$/.exec(raw);
  if (angled) {
    const [, name, address] = angled;
    return { name: name?.replace(/^"|"$/g, "") || address!, address: address! };
  }
  const bare = raw.trim();
  return bare.includes("@") ? { name: bare, address: bare } : null;
}

@Injectable()
export class MailSettingsService {
  private readonly logger = new Logger(MailSettingsService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * The encryption key, read fresh rather than cached at construction.
   *
   * An instance that never touches mail must still boot without
   * MAIL_ENCRYPTION_KEY — reading it in the constructor would make an unused
   * feature a hard startup dependency for every operator on the platform.
   */
  private key(): Buffer {
    return readKey(this.config.get<string>("MAIL_ENCRYPTION_KEY"), "MAIL_ENCRYPTION_KEY");
  }

  /**
   * The configuration in the environment, if there is one.
   *
   * `.env.example` has shipped SMTP_HOST/PORT/FROM since the beginning and
   * nothing has ever read them; docker-compose runs Mailpit on 1025 for exactly
   * this. Honouring them means a fresh checkout can send mail before anyone opens
   * the settings screen, and it means the dev instance's captured mail keeps
   * working. A saved row always wins — an operator who configured a server did so
   * on purpose.
   */
  private fromEnv(): ResolvedMailConfig | null {
    const host = this.config.get<string>("SMTP_HOST");
    if (!host) return null;

    const from = parseFrom(this.config.get<string>("SMTP_FROM") ?? "");
    if (!from) return null;

    const user = this.config.get<string>("SMTP_USER");
    const pass = this.config.get<string>("SMTP_PASSWORD");

    return {
      host,
      port: Number(this.config.get("SMTP_PORT") ?? 587) || 587,
      secure: this.config.get("SMTP_SECURE") === "true",
      auth: user && pass ? { user, pass } : null,
      from,
      replyTo: null,
    };
  }

  /**
   * What the SMTP client needs, or null when this site cannot send at all.
   *
   * Read through the SYSTEM client with an explicit tenant filter, not `db()`.
   * Delivery runs from a queued job, outside any request's tenant transaction —
   * the tenant-bound handle would be querying a transaction that committed and
   * closed minutes ago. Same reasoning as PluginsService, and the tenant id comes
   * from the job, which got it from the signed token or the actor.
   */
  async resolve(tenantId: string, siteId: string): Promise<ResolvedMailConfig | null> {
    const row = await getSystemDb().siteMailSettings.findFirst({
      where: { tenantId, siteId },
    });

    if (!row) return this.fromEnv();
    // Configured and switched off is not the same as never configured: it means
    // "stop sending", and falling back to the environment would do the opposite.
    if (!row.enabled) return null;

    let pass: string | null = null;
    if (row.passwordEncrypted) {
      try {
        pass = decryptSecret(row.passwordEncrypted, this.key());
      } catch (err) {
        // A wrong or rotated key. Sending without the password would authenticate
        // as nobody and be rejected by the server with a confusing error; failing
        // here names the actual problem.
        this.logger.error(
          `Cannot decrypt the SMTP password for site ${siteId}: ${(err as Error).message}`,
        );
        throw new Error("The stored SMTP password could not be decrypted. Re-enter it in Settings → Mail.");
      }
    }

    return {
      host: row.host,
      port: row.port,
      secure: row.secure,
      auth: row.username && pass ? { user: row.username, pass } : null,
      from: { name: row.fromName, address: row.fromEmail },
      replyTo: row.replyTo,
    };
  }

  /** What the admin screen renders. The password is not in it, in any form. */
  async read(siteId: string): Promise<MailSettingsDto> {
    const row = await db().siteMailSettings.findFirst({ where: { siteId } });

    if (!row) {
      const env = this.fromEnv();
      if (!env) return EMPTY;
      return {
        enabled: true,
        host: env.host,
        port: env.port,
        secure: env.secure,
        username: env.auth?.user ?? null,
        hasPassword: Boolean(env.auth?.pass),
        fromName: env.from.name,
        fromEmail: env.from.address,
        replyTo: null,
        lastTestAt: null,
        lastTestError: null,
        fromEnv: true,
      };
    }

    return {
      enabled: row.enabled,
      host: row.host,
      port: row.port,
      secure: row.secure,
      username: row.username,
      hasPassword: Boolean(row.passwordEncrypted),
      fromName: row.fromName,
      fromEmail: row.fromEmail,
      replyTo: row.replyTo,
      lastTestAt: row.lastTestAt?.toISOString() ?? null,
      lastTestError: row.lastTestError,
      fromEnv: false,
    };
  }

  /**
   * Upsert. `password` is write-only and three-valued, which the form depends on:
   *
   *   undefined  — the admin did not touch the field. Keep what is stored.
   *   ""         — the admin cleared it. Drop the credential.
   *   a string   — the new password. Encrypt it.
   *
   * Without the first case, an admin who changed the port would have to retype a
   * password they cannot see, and the field would have to be pre-filled with the
   * real one to make that bearable. That is how secrets end up in HTML.
   */
  async save(
    tenantId: string,
    siteId: string,
    input: MailSettings,
  ): Promise<MailSettingsDto> {
    const existing = await db().siteMailSettings.findFirst({ where: { siteId } });

    let passwordEncrypted: string | null | undefined;
    if (input.password !== undefined) {
      passwordEncrypted = input.password ? encryptSecret(input.password, this.key()) : null;
    }

    const fields = {
      enabled: input.enabled,
      host: input.host.trim(),
      port: input.port,
      secure: input.secure,
      username: input.username?.trim() || null,
      fromName: input.fromName.trim(),
      fromEmail: input.fromEmail.trim().toLowerCase(),
      replyTo: input.replyTo?.trim().toLowerCase() || null,
    };

    if (existing) {
      await db().siteMailSettings.update({
        where: { id: existing.id },
        data: {
          ...fields,
          ...(passwordEncrypted === undefined ? {} : { passwordEncrypted }),
          // The old result describes the old server. Saying "tested OK" about a
          // host that was just changed is worse than saying nothing.
          lastTestAt: null,
          lastTestError: null,
        },
      });
    } else {
      await db().siteMailSettings.create({
        data: {
          tenantId,
          siteId,
          ...fields,
          passwordEncrypted: passwordEncrypted ?? null,
        },
      });
    }

    return this.read(siteId);
  }

  /** Records what the SMTP server said, so the screen can show it. */
  async recordTest(siteId: string, error: string | null): Promise<void> {
    await db().siteMailSettings.updateMany({
      where: { siteId },
      data: { lastTestAt: new Date(), lastTestError: error },
    });
  }
}

/** Nothing configured, nothing in the environment. The screen renders a blank form. */
const EMPTY: MailSettingsDto = {
  enabled: false,
  host: "",
  port: 587,
  secure: false,
  username: null,
  hasPassword: false,
  fromName: "",
  fromEmail: "",
  replyTo: null,
  lastTestAt: null,
  lastTestError: null,
  fromEnv: false,
};
