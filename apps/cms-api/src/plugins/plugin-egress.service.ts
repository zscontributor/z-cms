import { BadRequestException, Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { getSystemDb } from "@zcmsorg/database";
import Redis from "ioredis";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { Agent, request as undiciRequest } from "undici";
import { t } from "../common/i18n";
import type { PluginTokenClaims } from "./plugin-token.service";
import {
  EgressRefused,
  MAX_REDIRECTS,
  MAX_RESPONSE_BODY,
  REQUEST_TIMEOUT_MS,
  exposeResponseHeaders,
  isBlockedAddress,
  parseAndCheckUrl,
  prepareRequest,
  redactSecrets,
  secretRefsIn,
} from "./plugin-egress";

/**
 * The socket a plugin does not have.
 *
 * A plugin describes a request; this service is what actually dials. That
 * indirection is not ceremony — it is where four checks live that a plugin could
 * not be trusted to make on its own, and it is the reason `network:fetch` is a
 * scope an admin can approve rather than a hole they have to hope about:
 *
 *   1. The host is one the installed version's manifest declared. Read from the
 *      database, on this request, not from anything the sandbox sent us.
 *   2. The address it resolves to is public. Checked at CONNECT time, not before
 *      it, which is the only place that check survives DNS rebinding.
 *   3. The credential is ours to spend. `{{secret:...}}` is substituted here, out
 *      of settings the sandbox was never given, after the host was approved.
 *   4. It is bounded — 10s, 1MB, and an hourly budget per site.
 *
 * Redirects are followed one hop at a time, and every hop goes through 1 and 2
 * again. An allowlisted host that answers with `Location: http://169.254.169.254/`
 * is the oldest trick there is, and `maxRedirections` in any HTTP client would
 * walk straight into it.
 */

const HOUR_SECONDS = 3600;
const DEFAULT_HOURLY_LIMIT = 1000;

interface EgressPolicy {
  hosts: string[];
  /** `{{secret:name}}` → the value, resolved out of the install's settings. */
  secrets: Record<string, string>;
  /** `{{secret:name}}` → which setting it came from. Declared, but perhaps unset. */
  declared: Record<string, string>;
}

@Injectable()
export class PluginEgressService implements OnModuleDestroy {
  private readonly logger = new Logger(PluginEgressService.name);
  private readonly redis: Redis;
  private readonly hourlyLimit: number;

  /**
   * One dispatcher, and the `lookup` on it is the load-bearing line in this file.
   *
   * undici calls it inside `net.connect`, for the connection it is about to make.
   * Resolving the name ourselves beforehand and then handing the *name* to a
   * client would leave a window — a TTL-0 record can answer 93.184.216.34 to our
   * check and 127.0.0.1 to the connect that follows a millisecond later. Here
   * there is no window: the addresses this returns are the addresses it dials.
   *
   * It refuses if *any* returned address is blocked, not merely the one that would
   * be picked. A round-robin record with one public and one private answer is a
   * rebinding attack with the retry built in.
   */
  private readonly agent = new Agent({
    connections: 8,
    headersTimeout: REQUEST_TIMEOUT_MS,
    bodyTimeout: REQUEST_TIMEOUT_MS,
    connect: {
      timeout: 5_000,
      lookup: (hostname, options, callback) => {
        dnsLookup(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
          if (err) return callback(err, "", 0);

          const resolved = addresses as LookupAddress[];
          const blocked = resolved.find((a) => isBlockedAddress(a.address));
          if (blocked) {
            this.logger.warn(
              `Refused plugin egress to ${hostname}: it resolves to ${blocked.address}, ` +
                `which is not a public address.`,
            );
            return callback(
              new EgressRefused(
                `"${hostname}" resolves to a private address (${blocked.address}). ` +
                  `A plugin may only reach the public internet.`,
              ),
              "",
              0,
            );
          }

          if (options.all) return callback(null, resolved as never, 0);
          callback(null, resolved[0].address, resolved[0].family);
        });
      },
    },
  });

  constructor(private readonly config: ConfigService) {
    this.redis = new Redis(config.get<string>("REDIS_URL") ?? "redis://localhost:6379", {
      maxRetriesPerRequest: 2,
      lazyConnect: true,
    });
    this.redis.on("error", (err) => this.logger.warn(`Redis: ${err.message}`));
    this.hourlyLimit =
      Number(config.get<string>("PLUGIN_HTTP_HOURLY_LIMIT")) || DEFAULT_HOURLY_LIMIT;
  }

  /**
   * Makes one outbound request on a plugin's behalf.
   *
   * `claims` comes from the signed token, so the tenant, site and plugin it names
   * are not negotiable — a plugin cannot borrow another's allowlist or another's
   * API key by forging a parameter, because those ids are not parameters.
   */
  async fetch(claims: PluginTokenClaims, params: Record<string, unknown>) {
    const policy = await this.policyFor(claims);

    if (policy.hosts.length === 0) {
      // Granted the scope, declared no hosts. Nothing to do — and saying so is
      // better than a confusing "not allowed to reach api.deepl.com" from a
      // plugin whose author simply forgot the manifest half of the bargain.
      throw new BadRequestException(t()("errors.plugins.noNetworkHosts", { plugin: claims.plg }));
    }

    const request = params.request;
    this.checkSecretsAreConfigured(request, policy);

    try {
      const prepared = prepareRequest(request, policy.hosts, policy.secrets);
      await this.consumeQuota(claims.sid, claims.plg);
      return await this.send(prepared, policy, claims);
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      // Everything from here on has been through secret substitution, so it may be
      // carrying an API key in its message. Redact before the plugin ever sees it.
      const message = redactSecrets((err as Error).message, policy.secrets);
      if (err instanceof EgressRefused) throw new BadRequestException(message);

      this.logger.warn(`Plugin ${claims.plg} egress failed: ${message}`);
      throw new BadRequestException(t()("errors.plugins.egressFailed", { reason: message }));
    }
  }

  /**
   * Sends the request, following redirects by hand.
   *
   * Two rules on a hop. The new URL is checked against the allowlist and the
   * address rules exactly as the first one was — an approved host does not get to
   * bounce us somewhere unapproved. And when the origin changes, the plugin's
   * headers are dropped: they may hold a substituted secret, and forwarding it to
   * a second host because the first said so would hand the admin's credential to
   * whoever the first host chose.
   */
  private async send(
    prepared: { url: string; method: string; headers: Record<string, string>; body?: string },
    policy: EgressPolicy,
    claims: PluginTokenClaims,
  ) {
    let url = prepared.url;
    let method = prepared.method;
    let body = prepared.body;
    let headers = prepared.headers;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await undiciRequest(url, {
        method: method as never,
        headers,
        body,
        dispatcher: this.agent,
        // undici's `request` does not follow redirects unless asked to, and it is
        // never asked to: following them is the loop above, which re-checks the
        // host and the address on every hop. A client-side `maxRedirections` would
        // follow `Location: https://169.254.169.254/` without telling anyone.
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      const location = res.headers.location;
      const redirecting = res.statusCode >= 300 && res.statusCode < 400 && Boolean(location);

      if (!redirecting) {
        return {
          status: res.statusCode,
          headers: exposeResponseHeaders(res.headers as Record<string, string>),
          body: await this.readBounded(res.body),
        };
      }

      if (hop === MAX_REDIRECTS) {
        res.body.destroy();
        throw new EgressRefused(`The request redirected more than ${MAX_REDIRECTS} times.`);
      }
      res.body.destroy();

      const target = new URL(String(location), url);
      const previous = new URL(url);
      // Same gate as the first hop, deliberately the same function: https, port
      // 443, and a host the manifest declared. The address check happens again too,
      // in the dispatcher's lookup, because it happens on every connect.
      parseAndCheckUrl(target.toString(), policy.hosts);

      if (target.origin !== previous.origin) {
        this.logger.debug(
          `Plugin ${claims.plg} redirected across origins; dropping its request headers.`,
        );
        headers = {};
      }

      // 303 always becomes a GET; 301 and 302 do too when the original was a POST,
      // which is what every browser and every HTTP client has done for thirty years
      // whatever the RFC once said. 307 and 308 exist precisely to preserve the
      // method, so they do.
      if (res.statusCode === 303 || ((res.statusCode === 301 || res.statusCode === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
        delete headers["content-type"];
      }

      url = target.toString();
    }

    throw new EgressRefused("The request redirected more than it was allowed to.");
  }

  /**
   * Reads the body, and stops reading at 1MB.
   *
   * The cap is enforced on the bytes as they arrive, not on `content-length` — a
   * server that lies in its headers, or sends none, is exactly the server this
   * limit exists for. The plugin's isolate has a 64MB heap and the response has to
   * cross into it as a JSON string; an unbounded read is an OOM in the sandbox and
   * a memory spike in cms-api, in that order.
   */
  private async readBounded(stream: AsyncIterable<Buffer>): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;

    for await (const chunk of stream) {
      size += chunk.length;
      if (size > MAX_RESPONSE_BODY) {
        throw new EgressRefused(
          `The response is larger than the ${MAX_RESPONSE_BODY / 1024 / 1024}MB limit.`,
        );
      }
      chunks.push(chunk);
    }

    return Buffer.concat(chunks).toString("utf8");
  }

  /**
   * The plugin's allowlist and its credentials, from the install row.
   *
   * Read fresh on every call, from the manifest of the version that is actually
   * installed. Not from the token, and not from the request: an admin who
   * downgrades a plugin, or a version whose manifest declares a host the previous
   * one did not, must take effect on the next call rather than on the next restart.
   */
  private async policyFor(claims: PluginTokenClaims): Promise<EgressPolicy> {
    const install = await getSystemDb().sitePlugin.findFirst({
      where: {
        tenantId: claims.tid,
        siteId: claims.sid,
        pluginId: claims.pid,
        status: "ACTIVE",
      },
      include: { version: { select: { manifest: true } } },
    });

    const manifest = install?.version.manifest as {
      network?: { hosts?: string[]; secrets?: Record<string, string> };
    } | null;

    const declared = manifest?.network?.secrets ?? {};
    const settings = (install?.settings ?? {}) as Record<string, unknown>;

    const secrets: Record<string, string> = {};
    for (const [name, settingKey] of Object.entries(declared)) {
      const value = settings[settingKey];
      if (typeof value === "string" && value) secrets[name] = value;
    }

    return { hosts: manifest?.network?.hosts ?? [], secrets, declared };
  }

  /**
   * Catches the commonest failure before it becomes a confusing one.
   *
   * A plugin that references `{{secret:apiKey}}` when the admin has not filled in
   * the API key setting would otherwise send the literal placeholder, get a 401
   * from the far end, and leave its author reading the wrong logs. Say the true
   * thing instead: the setting is empty.
   */
  private checkSecretsAreConfigured(request: unknown, policy: EgressPolicy): void {
    for (const ref of secretRefsIn(JSON.stringify(request ?? {}))) {
      const settingKey = policy.declared[ref];
      // Undeclared refs are prepareRequest's business, and it refuses them.
      if (!settingKey || policy.secrets[ref]) continue;
      throw new BadRequestException(
        t()("errors.plugins.secretNotConfigured", { secret: ref, setting: settingKey }),
      );
    }
  }

  /**
   * Charges one request against the site's hourly budget.
   *
   * Per site, not per plugin, for the same reason mail is: what is being protected
   * is the operator's egress bill and the site's standing with whatever service is
   * on the other end, and four plugins looping 250 times each spend that just as
   * fast as one looping 1000 times.
   *
   * Fails CLOSED. A plugin's retry loop against a paid API is the exact thing this
   * exists to stop, and "Redis blinked" is not a good enough reason to let it run.
   */
  private async consumeQuota(siteId: string, pluginKey: string): Promise<void> {
    const key = `plugin:http:quota:${siteId}`;

    try {
      const used = await this.redis.incr(key);
      if (used === 1) await this.redis.expire(key, HOUR_SECONDS);

      if (used > this.hourlyLimit) {
        const ttl = await this.redis.ttl(key);
        this.logger.warn(
          `Site ${siteId} hit the plugin egress quota (${this.hourlyLimit}/h); ` +
            `${pluginKey} was refused.`,
        );
        throw new BadRequestException(
          t()("errors.plugins.egressQuotaExceeded", {
            limit: String(this.hourlyLimit),
            retryAfterSec: String(ttl > 0 ? ttl : HOUR_SECONDS),
          }),
        );
      }
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      this.logger.error(`Egress quota check failed for site ${siteId}: ${(err as Error).message}`);
      throw new BadRequestException(t()("errors.plugins.egressQuotaUnavailable"));
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.agent.close().catch(() => undefined);
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }
}
