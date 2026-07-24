import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";

/**
 * The denylist that makes session revocation actually immediate.
 *
 * Access tokens are stateless JWTs — that is what makes them cheap to verify, and
 * it is also why revoking a session could not touch one already in flight. A
 * logged-out user stayed logged in for up to the access TTL (15 minutes), and so
 * did a thief whose token family had just been revoked for reuse. Fifteen minutes
 * is a long time to hold a stolen admin session.
 *
 * So each access token names its session (`fid`, the refresh rotation family),
 * and revoking a family writes it here. The guard checks the list on every
 * request.
 *
 * Two properties keep this from becoming a stateful mess:
 *
 *   - Entries EXPIRE after the access TTL. Once every access token that could
 *     name the family has expired on its own, the denylist entry is pointless —
 *     so the list only ever holds the families revoked in the last few minutes,
 *     not every session ever ended.
 *
 *   - It FAILS CLOSED. If Redis is unreachable we cannot prove a token is still
 *     valid, and this is an authorisation control, not a rate limiter: the
 *     request is refused. (The login limiter fails open for the opposite reason —
 *     it is a mitigation, and the password check behind it is the real gate.)
 */
@Injectable()
export class RevocationService implements OnModuleDestroy {
  private readonly logger = new Logger(RevocationService.name);
  private readonly redis: Redis;
  private readonly ttlSec: number;

  constructor(config: ConfigService) {
    this.redis = new Redis(config.get<string>("REDIS_URL") ?? "redis://localhost:6379", {
      maxRetriesPerRequest: 2,
    });
    this.redis.on("error", (err) => this.logger.warn(`Redis: ${err.message}`));

    // Must outlive any access token that could still name a revoked family.
    // Generous slack: the cost of an over-long entry is a few bytes.
    this.ttlSec = parseTtlSeconds(config.get<string>("JWT_ACCESS_TTL") ?? "15m") + 60;
  }

  private key(familyId: string): string {
    return `revoked:family:${familyId}`;
  }

  async revoke(familyId: string): Promise<void> {
    try {
      await this.redis.set(this.key(familyId), "1", "EX", this.ttlSec);
    } catch (err) {
      // A revocation that did not land is a security failure, not a hiccup: say
      // so loudly. The refresh token is still revoked in Postgres, so the session
      // cannot be *extended* — only the current access token survives its TTL.
      this.logger.error(
        `Could not deny-list revoked session ${familyId}: ${(err as Error).message}. ` +
          `Its access token stays valid until it expires.`,
      );
    }
  }

  /** True when the session behind this token has been revoked. Fails CLOSED. */
  async isRevoked(familyId: string): Promise<boolean> {
    try {
      return (await this.redis.exists(this.key(familyId))) === 1;
    } catch (err) {
      this.logger.error(
        `Revocation check failed (${(err as Error).message}) — refusing the request. ` +
          `An authorisation control that cannot answer must not say yes.`,
      );
      return true;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }
}

/** "15m" | "12h" | "30d" | "900" -> seconds. */
function parseTtlSeconds(ttl: string): number {
  const match = /^(\d+)\s*([smhd])?$/.exec(ttl.trim());
  if (!match) return 900;
  const value = Number(match[1]);
  const unit = (match[2] ?? "s") as "s" | "m" | "h" | "d";
  return value * { s: 1, m: 60, h: 3600, d: 86_400 }[unit];
}
