import { BlockList, isIP } from "node:net";

/**
 * The rules a plugin's outbound request has to survive, with no I/O in sight.
 *
 * Everything here is a pure function of (what the plugin asked for, what its
 * manifest declared). That is deliberate: this is the file where a mistake is a
 * server-side request forgery, and a rule that cannot be unit-tested without a
 * socket is a rule nobody will test. The service next door does the DNS, the
 * Redis and the HTTP; it decides nothing.
 */

// ---------------------------------------------------------------------------
// Where a plugin may go
// ---------------------------------------------------------------------------

/**
 * Address ranges no plugin may reach, whatever its manifest says.
 *
 * This is the list that matters. A plugin's allowlist protects the *admin* from
 * the plugin talking to the wrong company; this list protects the *operator* from
 * the plugin talking to the machine it is running on. `169.254.169.254` — the
 * cloud metadata endpoint, one unauthenticated GET away from the instance's IAM
 * credentials — is the reason SSRF is a critical-severity bug class and not a
 * curiosity, and it is a perfectly ordinary public-looking hostname away.
 *
 * So the check is on the resolved ADDRESS, never on the name. A hostname the
 * plugin declared honestly, on a domain it owns, whose A record points at
 * 127.0.0.1, is the whole attack — and it is an attack that costs nothing to
 * mount, because the attacker owns the DNS.
 */
function buildBlockList(): BlockList {
  const list = new BlockList();

  // IPv4. The RFC 1918 ranges everyone remembers, plus the ones they do not:
  // carrier-grade NAT, the benchmarking range, and the "this network" /8 that
  // 0.0.0.0 lives in and which some stacks route to localhost.
  list.addSubnet("0.0.0.0", 8, "ipv4"); // "this" network
  list.addSubnet("10.0.0.0", 8, "ipv4"); // RFC 1918
  list.addSubnet("100.64.0.0", 10, "ipv4"); // RFC 6598 CGNAT
  list.addSubnet("127.0.0.0", 8, "ipv4"); // loopback
  list.addSubnet("169.254.0.0", 16, "ipv4"); // link-local — cloud metadata lives here
  list.addSubnet("172.16.0.0", 12, "ipv4"); // RFC 1918
  list.addSubnet("192.0.0.0", 24, "ipv4"); // IETF protocol assignments
  list.addSubnet("192.0.2.0", 24, "ipv4"); // TEST-NET-1
  list.addSubnet("192.168.0.0", 16, "ipv4"); // RFC 1918
  list.addSubnet("198.18.0.0", 15, "ipv4"); // benchmarking
  list.addSubnet("198.51.100.0", 24, "ipv4"); // TEST-NET-2
  list.addSubnet("203.0.113.0", 24, "ipv4"); // TEST-NET-3
  list.addSubnet("224.0.0.0", 4, "ipv4"); // multicast
  list.addSubnet("240.0.0.0", 4, "ipv4"); // reserved, and 255.255.255.255 with it

  // IPv6. Note ::/128 and ::1/128 separately — an unspecified address is not a
  // loopback address, and both of them reach the local machine.
  list.addAddress("::", "ipv6");
  list.addAddress("::1", "ipv6");
  list.addSubnet("fc00::", 7, "ipv6"); // unique local
  list.addSubnet("fe80::", 10, "ipv6"); // link-local
  list.addSubnet("ff00::", 8, "ipv6"); // multicast
  list.addSubnet("64:ff9b::", 96, "ipv6"); // NAT64 — an IPv4 address in disguise
  list.addSubnet("2001:db8::", 32, "ipv6"); // documentation

  return list;
}

const BLOCKED = buildBlockList();

/**
 * Strips the two encodings that let an IPv4 address arrive dressed as an IPv6
 * one. `::ffff:127.0.0.1` is loopback; a check that only consulted the IPv6 rules
 * would wave it through, and this is the single most common way an SSRF filter is
 * bypassed in the wild.
 */
function unwrapIpv4(address: string): { ip: string; family: "ipv4" | "ipv6" } {
  const lower = address.toLowerCase();
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  if (mapped && isIP(mapped[1]) === 4) return { ip: mapped[1], family: "ipv4" };

  // ::ffff:7f00:1 — the same address, written in hextets rather than dotted quad.
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16);
    return {
      ip: [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."),
      family: "ipv4",
    };
  }

  return { ip: address, family: isIP(address) === 4 ? "ipv4" : "ipv6" };
}

/** True when the address is one no plugin is allowed to be pointed at. */
export function isBlockedAddress(address: string): boolean {
  const { ip, family } = unwrapIpv4(address);
  // Not an IP at all: something upstream handed us a hostname. Refuse rather than
  // guess — every caller of this reaches a socket if it returns false.
  if (isIP(ip) === 0) return true;
  return BLOCKED.check(ip, family);
}

/**
 * Does `hostname` match one of the plugin's declared hosts?
 *
 * `*.deepl.com` matches `api.deepl.com` but NOT `deepl.com`, and not
 * `notdeepl.com` — the suffix compared always includes the dot, so a wildcard can
 * never be widened into its own parent domain by a plugin that omits one.
 */
export function hostAllowed(hostname: string, allowlist: readonly string[]): boolean {
  // A trailing dot is a legal, fully-qualified way to write the same name, and it
  // resolves the same. Strip it, or `api.deepl.com.` would be a host the plugin
  // could reach without ever declaring it.
  const host = hostname.toLowerCase().replace(/\.$/, "");

  return allowlist.some((raw) => {
    const entry = raw.toLowerCase().trim();
    if (entry.startsWith("*.")) {
      const suffix = entry.slice(1); // ".deepl.com" — keeps the dot
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    return host === entry;
  });
}

const HOST_PATTERN = /^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

/**
 * Checks a manifest's `network.hosts` at install time, so a bad declaration is a
 * refused install rather than a surprise at runtime.
 *
 * Returns the offending entries. There is deliberately no way to declare `*`, an
 * IP literal, a scheme, a port or a path: each of those is either a request for
 * the open internet (which no admin could meaningfully approve) or an attempt to
 * smuggle something past `hostAllowed`, which compares hostnames and nothing else.
 */
export function invalidHostDeclarations(hosts: readonly string[]): string[] {
  return hosts.filter((raw) => {
    const entry = String(raw).toLowerCase().trim();
    if (!entry || entry === "*" || entry === "*.*") return true;
    if (entry.includes("/") || entry.includes(":") || entry.includes("@")) return true;
    // An IP literal would sail past the hostname rules but land straight in the
    // address check, where it belongs to nobody. Refuse it where it is readable.
    if (isIP(entry) !== 0) return true;
    if (entry === "localhost" || entry.endsWith(".localhost") || entry.endsWith(".local")) {
      return true;
    }
    return !HOST_PATTERN.test(entry);
  });
}

// ---------------------------------------------------------------------------
// Secrets the plugin spends without holding
// ---------------------------------------------------------------------------

const SECRET_REF = /\{\{secret:([a-zA-Z0-9_.-]{1,64})\}\}/g;

export class EgressRefused extends Error {}

/**
 * Replaces every `{{secret:name}}` with the value the manifest mapped it to.
 *
 * An unknown placeholder throws rather than passing through. The alternative —
 * sending the literal string `{{secret:apiKey}}` as an Authorization header — is
 * an authentication failure the plugin author would debug for an hour, and it
 * makes the substitution silently optional, which is exactly what a rule about
 * credentials must never be.
 *
 * `encode` is on for the URL: a secret is arbitrary bytes, and one containing `#`
 * or `&` would otherwise rewrite the query around it.
 */
export function substituteSecrets(
  input: string,
  secrets: Record<string, string>,
  encode = false,
): string {
  return input.replace(SECRET_REF, (_match, name: string) => {
    const value = secrets[name];
    if (value === undefined) {
      throw new EgressRefused(
        `The plugin referenced {{secret:${name}}}, which its manifest does not declare under network.secrets.`,
      );
    }
    return encode ? encodeURIComponent(value) : value;
  });
}

/** Every `{{secret:name}}` a plugin referenced, so the caller can check them all up front. */
export function secretRefsIn(input: string): string[] {
  return [...input.matchAll(SECRET_REF)].map((m) => m[1]);
}

/**
 * Removes secret values from anything on its way back to the plugin.
 *
 * Not paranoia — a necessity, and a subtle one. A plugin may write
 * `https://{{secret:apiKey}}/` and read the key straight out of the "you are not
 * allowed to reach <hostname>" error it gets back. Every message this module
 * produces is substituted text, so every message goes through here first, and the
 * plugin learns that its request was refused without learning what it was
 * refused *with*.
 */
export function redactSecrets(text: string, secrets: Record<string, string>): string {
  let out = text;
  for (const value of Object.values(secrets)) {
    // Guard against a setting that is empty or a single character: replacing "" or
    // "a" globally would shred the message rather than redact it.
    if (value && value.length >= 4) out = out.split(value).join("«secret»");
  }
  return out;
}

// ---------------------------------------------------------------------------
// The request itself
// ---------------------------------------------------------------------------

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/**
 * Headers a plugin may not set, because they describe the connection rather than
 * the message. Letting a plugin write `Host` would let it reach one server while
 * the allowlist checked another; the rest are hop-by-hop headers that undici owns
 * and a plugin cannot improve on.
 */
const FORBIDDEN_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "expect",
  "proxy-authorization",
  "proxy-connection",
]);

export const MAX_HEADERS = 24;
export const MAX_HEADER_VALUE = 4096;
export const MAX_REQUEST_BODY = 256 * 1024;
export const MAX_RESPONSE_BODY = 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 10_000;
export const MAX_REDIRECTS = 3;

export interface EgressRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/**
 * Turns whatever the plugin sent into a request we are willing to make, or throws.
 *
 * The order here is the security property, not a style choice. Secrets are
 * substituted into the URL *before* it is parsed and *before* the host is checked
 * — because a plugin can write `https://{{secret:key}}/steal`, and a check that
 * ran first would validate a hostname that no longer exists by the time we dial.
 * Substitute, then parse, then judge what you will actually connect to.
 */
export function prepareRequest(
  raw: unknown,
  allowlist: readonly string[],
  secrets: Record<string, string>,
): EgressRequest {
  const req = (raw ?? {}) as Record<string, unknown>;

  if (typeof req.url !== "string" || !req.url) {
    throw new EgressRefused("http.fetch needs a url.");
  }

  const method = String(req.method ?? "GET").toUpperCase();
  if (!METHODS.has(method)) {
    throw new EgressRefused(`http.fetch cannot use the method "${method}".`);
  }

  const url = parseAndCheckUrl(substituteSecrets(req.url, secrets, true), allowlist);

  const headers: Record<string, string> = {};
  const given = (req.headers ?? {}) as Record<string, unknown>;
  const names = Object.keys(given);
  if (names.length > MAX_HEADERS) {
    throw new EgressRefused(`http.fetch allows at most ${MAX_HEADERS} headers.`);
  }
  for (const name of names) {
    const lower = name.toLowerCase();
    if (!/^[a-z0-9-]+$/.test(lower)) {
      throw new EgressRefused(`"${name}" is not a valid header name.`);
    }
    if (FORBIDDEN_HEADERS.has(lower)) {
      throw new EgressRefused(`A plugin may not set the "${lower}" header.`);
    }
    const value = substituteSecrets(String(given[name] ?? ""), secrets);
    if (value.length > MAX_HEADER_VALUE) {
      throw new EgressRefused(`The "${lower}" header is longer than ${MAX_HEADER_VALUE} bytes.`);
    }
    // A newline in a header value is request splitting: everything after it is
    // read by the server as a header of its own, or as the start of a second
    // request on the same connection.
    if (/[\r\n]/.test(value)) {
      throw new EgressRefused(`The "${lower}" header contains a line break.`);
    }
    headers[lower] = value;
  }

  let body: string | undefined;
  if (req.body !== undefined && req.body !== null && method !== "GET") {
    const text =
      typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    body = substituteSecrets(text, secrets);
    if (Buffer.byteLength(body) > MAX_REQUEST_BODY) {
      throw new EgressRefused(
        `The request body is larger than the ${MAX_REQUEST_BODY / 1024}KB limit.`,
      );
    }
    if (typeof req.body !== "string" && !headers["content-type"]) {
      headers["content-type"] = "application/json";
    }
  }

  return { url: url.toString(), method, headers, body };
}

/**
 * Parses a URL and answers the only question that matters: may we dial it?
 *
 * HTTPS only, and on 443 only. Not because plaintext is unfashionable but because
 * a plugin's request carries a credential the *admin* owns and the plugin cannot
 * read — putting that on the wire in the clear would make the whole
 * `network.secrets` bargain a lie. The port rule is what stops an allowlisted
 * hostname whose A record the plugin's author controls from being aimed at
 * something interesting listening on 8500 inside our own network; the address
 * check catches that too, and this is the belt to its braces.
 */
export function parseAndCheckUrl(input: string, allowlist: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new EgressRefused("http.fetch was given something that is not a URL.");
  }

  if (url.protocol !== "https:") {
    throw new EgressRefused(
      `http.fetch only speaks https, and was asked for "${url.protocol.replace(":", "")}".`,
    );
  }
  if (url.username || url.password) {
    throw new EgressRefused("A URL for http.fetch may not carry credentials.");
  }
  if (url.port && url.port !== "443") {
    throw new EgressRefused(`http.fetch only reaches port 443, not ${url.port}.`);
  }
  if (!hostAllowed(url.hostname, allowlist)) {
    throw new EgressRefused(
      `This plugin is not allowed to reach "${url.hostname}". ` +
        `Its manifest declares: ${allowlist.length ? allowlist.join(", ") : "no hosts at all"}.`,
    );
  }

  return url;
}

/**
 * Response headers the plugin gets to see.
 *
 * An allowlist, not a denylist. `set-cookie` is the one that has to go — handing a
 * plugin a session cookie for a service the *admin's* credential just
 * authenticated to would give it a way to keep using that credential's session
 * after we stopped substituting the secret for it.
 */
const EXPOSED_RESPONSE_HEADERS = new Set([
  "content-type",
  "content-length",
  "etag",
  "last-modified",
  "cache-control",
  "retry-after",
  "location",
  "x-request-id",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
]);

export function exposeResponseHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!EXPOSED_RESPONSE_HEADERS.has(lower) || value === undefined) continue;
    out[lower] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return out;
}
