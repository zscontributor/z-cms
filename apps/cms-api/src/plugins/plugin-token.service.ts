import { randomUUID } from "node:crypto";
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import type { Permission } from "@zcmsorg/schemas";
import Redis from "ioredis";
import { t } from "../common/i18n";

/**
 * The credential a plugin runs under.
 *
 * It is NOT a user session. It names the plugin, the one site it may act on, and
 * the exact scopes the admin granted — and it lives for seconds, because it is
 * minted per invocation and handed to the sandbox for the length of one hook.
 *
 * The consequences are worth being explicit about:
 *   - A plugin token stolen from a compromised plugin-runtime expires almost
 *     immediately and works on one site, with one plugin's scopes.
 *   - The scopes travel *in the token*, signed. The gateway never trusts a
 *     plugin's word about what it is allowed to do.
 *   - It is signed with a different key than user tokens, so a plugin token can
 *     never be replayed as a user session, nor the reverse.
 */

export interface PluginTokenClaims {
  /** Plugin key, e.g. "vn.zsoft.plugin.seo". */
  plg: string;
  /** Plugin row id — what plugin_data is stamped with. */
  pid: string;
  tid: string;
  sid: string;
  scopes: Permission[];
  /** Unique id for this minted token, so it can be retired after its one use. */
  jti?: string;
}

const PLUGIN_TOKEN_TTL = "60s";
const PLUGIN_TOKEN_TTL_SEC = 60;

@Injectable()
export class PluginTokenService implements OnModuleDestroy {
  private readonly logger = new Logger(PluginTokenService.name);
  private readonly redis: Redis;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {
    this.redis = new Redis(
      config.get<string>("REDIS_URL") ?? "redis://localhost:6379",
      // lazyConnect: no socket is opened until the first retire/verify call, so
      // constructing the service (including in unit tests) touches no network.
      { maxRetriesPerRequest: 2, lazyConnect: true },
    );
    this.redis.on("error", (err) => this.logger.warn(`Redis: ${err.message}`));
  }

  /** Mints a token and returns it alongside its `jti`, so the caller can retire
   *  the token the moment the invocation it was minted for has finished. */
  async mint(claims: PluginTokenClaims): Promise<{ token: string; jti: string }> {
    const jti = randomUUID();
    const token = await this.jwt.signAsync(
      { ...claims, jti },
      { secret: this.secret(), expiresIn: PLUGIN_TOKEN_TTL },
    );
    return { token, jti };
  }

  async verify(token: string): Promise<PluginTokenClaims> {
    let claims: PluginTokenClaims;
    try {
      claims = await this.jwt.verifyAsync<PluginTokenClaims>(token, {
        secret: this.secret(),
      });
    } catch {
      throw new UnauthorizedException(t()("errors.plugins.invalidToken"));
    }
    if (claims.jti && (await this.isRetired(claims.jti))) {
      // The invocation this token was minted for has already returned. A second
      // presentation is a replay of a captured token, not a legitimate call.
      throw new UnauthorizedException(t()("errors.plugins.invalidToken"));
    }
    return claims;
  }

  /** Retire a token once its invocation is done. Best-effort: this is replay
   *  hardening on top of an already short-lived, single-site, single-plugin
   *  token, so a Redis hiccup must not fail the request — it just leaves the
   *  token to expire on its own 60s TTL, exactly as before this existed. */
  async retire(jti: string): Promise<void> {
    try {
      await this.redis.set(`plugin:jti:retired:${jti}`, "1", "EX", PLUGIN_TOKEN_TTL_SEC);
    } catch (err) {
      this.logger.warn(`Could not retire plugin token ${jti}: ${(err as Error).message}`);
    }
  }

  /** True when a token has been retired. FAILS OPEN, deliberately: see retire(). */
  private async isRetired(jti: string): Promise<boolean> {
    try {
      return (await this.redis.exists(`plugin:jti:retired:${jti}`)) === 1;
    } catch {
      return false;
    }
  }

  private secret(): string {
    return `${this.config.getOrThrow<string>("JWT_SECRET")}:plugin`;
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      // A lazyConnect client that never opened (e.g. in a unit test) has nothing
      // to QUIT; drop the connection without waiting on a handshake.
      this.redis.disconnect();
    }
  }
}
