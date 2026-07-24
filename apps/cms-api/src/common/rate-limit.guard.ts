import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import Redis from "ioredis";
import { RATE_LIMIT_KEY, type RateLimitRule } from "./rate-limit.decorator";

/**
 * A Redis fixed-window rate limiter.
 *
 * It exists mainly for `/auth/login`: without it, a stolen password list can be
 * checked against the API as fast as the network allows, and the constant-time
 * bcrypt comparison only slows each guess, it does not cap them.
 *
 * "Fail open" is a deliberate choice for THIS limiter. If Redis is down, the
 * limiter lets the request through rather than locking every user out of the
 * product because the cache blinked. Login rate limiting is a brute-force
 * mitigation, not an authorisation control — the password check behind it is the
 * actual gate. A limiter that becomes a self-inflicted outage is worse than one
 * that occasionally misses.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);
  private readonly redis: Redis;

  constructor(
    private readonly reflector: Reflector,
    config: ConfigService,
  ) {
    this.redis = new Redis(config.get<string>("REDIS_URL") ?? "redis://localhost:6379", {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: false,
    });
    this.redis.on("error", (err) => this.logger.warn(`Redis: ${err.message}`));
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const rules = this.reflector.getAllAndOverride<RateLimitRule[]>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!rules?.length) return true;

    const req = context.switchToHttp().getRequest<Request>();

    // Each rule is its own budget with its own key. The request must clear all of
    // them; the tightest one wins. A rule whose subject is absent (no email in
    // the body) is simply skipped rather than treated as a match.
    for (const rule of rules) {
      const key = this.keyFor(rule, req);
      if (!key) continue;

      const state = await this.hit(key, rule.windowSec, rule.points);
      if (!state.allowed) {
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message: "Too many attempts. Try again later.",
            retryAfterSec: state.retryAfterSec,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    return true;
  }

  private keyFor(rule: RateLimitRule, req: Request): string | null {
    const route = `${req.method}:${req.path}`;

    if (rule.by === "ip") {
      return `rl:${route}:ip:${this.clientIp(req)}`;
    }

    const email = (req.body as { email?: unknown })?.email;
    if (typeof email === "string" && email) {
      return `rl:${route}:email:${email.toLowerCase()}`;
    }
    return null;
  }

  private async hit(
    key: string,
    windowSec: number,
    points: number,
  ): Promise<{ allowed: boolean; retryAfterSec: number }> {
    try {
      // INCR + set TTL only on the first hit of the window. A fixed window is
      // enough for brute-force defence and costs one round trip.
      const count = await this.redis.incr(key);
      if (count === 1) {
        await this.redis.expire(key, windowSec);
      }
      if (count > points) {
        const ttl = await this.redis.ttl(key);
        return { allowed: false, retryAfterSec: ttl > 0 ? ttl : windowSec };
      }
      return { allowed: true, retryAfterSec: 0 };
    } catch (err) {
      // Fail open — see the class comment.
      this.logger.warn(`Rate limit check skipped (Redis): ${(err as Error).message}`);
      return { allowed: true, retryAfterSec: 0 };
    }
  }

  /**
   * The client IP. Behind a proxy, Express fills req.ip from X-Forwarded-For only
   * when `trust proxy` is set — which main.ts does. Without that, a client could
   * forge X-Forwarded-For to dodge the IP limit, so the app-level trust setting
   * is what makes this key trustworthy.
   */
  private clientIp(req: Request): string {
    return req.ip ?? req.socket.remoteAddress ?? "unknown";
  }
}
