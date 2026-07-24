import { SetMetadata } from "@nestjs/common";

export const RATE_LIMIT_KEY = "rate-limit";

export interface RateLimitRule {
  /** What to key this limit on. "ip" is always available; "email" reads the body. */
  by: "ip" | "email";
  /** Allowed requests per window. */
  points: number;
  /** Window length in seconds. */
  windowSec: number;
}

/**
 * Rate limits a route with one or more INDEPENDENT rules — the request must pass
 * every one. Keeping them independent is the point: the per-email limit and the
 * per-IP limit defend against different attacks and deserve different budgets.
 *
 *   @RateLimit(
 *     { by: "email", points: 5,  windowSec: 900 },  // one account, many guesses
 *     { by: "ip",    points: 30, windowSec: 900 },  // one host, many accounts
 *   )
 */
export const RateLimit = (...rules: RateLimitRule[]) =>
  SetMetadata(RATE_LIMIT_KEY, rules);
