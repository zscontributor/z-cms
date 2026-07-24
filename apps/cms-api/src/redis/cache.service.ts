import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { getSystemDb } from "@zcmsorg/database";
import { hostnameVariants } from "@zcmsorg/schemas";
import Redis from "ioredis";

/**
 * Redis is the read path for public pages.
 *
 * A render payload is expensive to build (site + theme + menus + content) and
 * almost never changes between requests, so it is cached under a key derived
 * from the site and the path. Publishing content drops exactly those keys and
 * pings site-runtime to drop its own cached render — precise invalidation, not
 * a global flush, so one edit does not cold-start every page on the platform.
 *
 * Site-wide invalidation is done by *version*, not by scanning. See
 * `invalidateSite`.
 */
@Injectable()
export class CacheService implements OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private readonly redis: Redis;
  private readonly ttl: number;

  constructor(private readonly config: ConfigService) {
    this.redis = new Redis(this.config.get<string>("REDIS_URL") ?? "redis://localhost:6379", {
      maxRetriesPerRequest: 2,
      lazyConnect: false,
    });
    this.redis.on("error", (err) => this.logger.warn(`Redis: ${err.message}`));
    this.ttl = Number(this.config.get("RENDER_CACHE_TTL") ?? 300);
  }

  /**
   * Render keys carry the site's cache version. Bumping the version orphans
   * every key of the previous generation in one write — see `invalidateSite`.
   */
  static renderKey(
    siteId: string,
    version: number,
    path: string,
    page: number,
    variant?: string,
  ): string {
    const suffix = variant ? `:${encodeURIComponent(variant)}` : "";
    return `cms:render:${siteId}:v${version}:${page}:${path}${suffix}`;
  }

  static hostKey(hostname: string): string {
    return `cms:host:${hostname}`;
  }

  /** Monotonic counter naming the current generation of a site's render cache. */
  static versionKey(siteId: string): string {
    return `cms:sitever:${siteId}`;
  }

  /**
   * The site's current cache version.
   *
   * A missing counter means "generation 0" — no bump has ever happened, which is
   * the correct reading for a site nobody has edited yet. A Redis failure reads
   * the same way: the worst case is that a request builds the payload and writes
   * it under a version nobody will read, i.e. a cache miss, never stale content.
   */
  async siteVersion(siteId: string): Promise<number> {
    try {
      const raw = await this.redis.get(CacheService.versionKey(siteId));
      return raw ? Number(raw) || 0 : 0;
    } catch (err) {
      this.logger.warn(`Cache version read failed for ${siteId}: ${(err as Error).message}`);
      return 0;
    }
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.redis.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch (err) {
      // A cache outage must degrade to a slow site, never a broken one.
      this.logger.warn(`Cache read failed for ${key}: ${(err as Error).message}`);
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(value), "EX", ttlSeconds ?? this.ttl);
    } catch (err) {
      this.logger.warn(`Cache write failed for ${key}: ${(err as Error).message}`);
    }
  }

  /**
   * Drops the cached renders for specific paths on a site, then asks
   * site-runtime to revalidate its own Next.js cache for the same paths.
   *
   * Page-level invalidation deletes exact keys, which is cheap and precise: the
   * key is fully derivable from (site, version, path, page).
   */
  async invalidateSitePaths(siteId: string, paths: string[]): Promise<void> {
    try {
      const version = await this.siteVersion(siteId);
      const keys: string[] = [];
      for (const path of paths) {
        // Archive pages are paginated; clear a reasonable window of them rather
        // than hunting the keyspace for however many pages happen to be cached.
        for (let page = 1; page <= 5; page++) {
          keys.push(CacheService.renderKey(siteId, version, path, page));
        }
      }
      if (keys.length) await this.redis.unlink(...keys);
    } catch (err) {
      this.logger.warn(`Cache invalidation failed: ${(err as Error).message}`);
    }

    await this.revalidateSiteRuntime(siteId, paths);
  }

  /**
   * Drops the hostname -> site lookups for the given hostnames.
   *
   * That lookup is cached separately from the renders and is NOT keyed by the
   * site's cache version, so bumping the version does not touch it. It holds the
   * site's name, locales and brand for ten minutes — which means that without
   * this, changing a site's logo leaves every visitor seeing the old one until the
   * TTL happens to lapse, and nothing an operator can do makes it go faster.
   *
   * Deleting by exact key: the caller knows the site's domains, so there is no
   * keyspace to scan.
   *
   * Each domain is expanded to BOTH of its spellings, because the cache is keyed by
   * the hostname that was *asked for*, not the one that was stored: a visitor on
   * "www.z-cms.org" populates a key of their own. Purging only the domains as
   * recorded would leave that one behind — and the operator would watch the apex
   * update while the www kept serving the old logo, with nothing to explain it.
   */
  async forgetHosts(hostnames: string[]): Promise<void> {
    if (hostnames.length === 0) return;
    const keys = [...new Set(hostnames.flatMap(hostnameVariants))].map((h) =>
      CacheService.hostKey(h),
    );
    try {
      await this.redis.unlink(...keys);
    } catch (err) {
      this.logger.warn(`Host cache purge failed: ${(err as Error).message}`);
    }
  }

  /**
   * Drops every cached render for a site by bumping its cache version.
   *
   * Needed when the change is site-wide rather than page-wide — activating a
   * theme or editing its settings changes the header, colours and footer of
   * every page, so purging just the edited path would leave the rest of the site
   * rendering the old theme until its TTL expired.
   *
   * This is one INCR. It does not touch the old keys at all: they are simply no
   * longer addressable, because every reader now composes keys with the new
   * version, and they fall out on their own TTL.
   *
   * The alternative — SCAN the keyspace for `cms:render:{siteId}:*` — costs a
   * cursor walk over *every* key in the instance to find the few thousand that
   * belong to one site. That is work proportional to the whole platform to serve
   * a single tenant's theme change, and it grows as other tenants grow. (KEYS is
   * worse still: it blocks the Redis event loop for the entire keyspace.)
   *
   * INVARIANT: the version counter must never expire. If it were evicted while
   * keys from an earlier generation were still live, a fresh INCR would return
   * to a version whose keys are still cached, and the site would serve stale
   * pages until their TTL ran out. The counter is written with no TTL, so
   * `volatile-*` eviction policies (which only consider keys that have one) can
   * never reclaim it. Do not run this Redis with `allkeys-lru`.
   */
  async invalidateSite(siteId: string): Promise<void> {
    try {
      await this.redis.incr(CacheService.versionKey(siteId));
    } catch (err) {
      this.logger.warn(`Site cache purge failed: ${(err as Error).message}`);
    }

    await this.revalidateSiteRuntime(siteId, []);
  }

  /**
   * Best-effort purge of the site-runtime's Next.js cache.
   *
   * site-runtime tags its cached renders by (hostname, path), not by site id —
   * it knows the Host header before it knows which site that resolves to. So the
   * API has to translate: one site can answer on several domains, and each of
   * them holds its own cached copy of the same page. Purging only one would
   * leave the others serving the old content.
   *
   * An empty `paths` purges the whole site (theme, menus — anything in the
   * chrome of every page).
   */
  private async revalidateSiteRuntime(siteId: string, paths: string[]): Promise<void> {
    const url = this.config.get<string>("SITE_RUNTIME_URL");
    // site-runtime verifies this against the token IT holds — its render token
    // when one is configured, else the shared privileged token.
    const token =
      this.config.get<string>("SITE_RUNTIME_INTERNAL_TOKEN") ??
      this.config.get<string>("CMS_INTERNAL_TOKEN");
    if (!url || !token) return;

    let hostnames: string[];
    try {
      // Domains are looked up with the system client: this runs from inside a
      // tenant transaction, and the mapping is not tenant-scoped data anyway.
      const domains = await getSystemDb().domain.findMany({
        where: { siteId },
        select: { hostname: true },
      });
      hostnames = domains.map((d) => d.hostname);
    } catch (err) {
      this.logger.warn(`Could not resolve hostnames for site ${siteId}: ${(err as Error).message}`);
      return;
    }

    await Promise.all(
      hostnames.map(async (hostname) => {
        try {
          const res = await fetch(`${url}/api/revalidate`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-internal-token": token,
            },
            body: JSON.stringify({ hostname, paths }),
            signal: AbortSignal.timeout(3000),
          });

          if (!res.ok) {
            this.logger.warn(
              `Revalidate rejected for ${hostname}: HTTP ${res.status} ${await res.text()}`,
            );
          }
        } catch (err) {
          // site-runtime may simply not be running (API-only deploys). Content is
          // still correct, just cached until its TTL expires.
          this.logger.debug(`Revalidate ping to ${hostname} failed: ${(err as Error).message}`);
        }
      }),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }
}
