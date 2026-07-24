import { describe, expect, it } from "vitest";
import {
  EgressRefused,
  exposeResponseHeaders,
  hostAllowed,
  invalidHostDeclarations,
  isBlockedAddress,
  parseAndCheckUrl,
  prepareRequest,
  redactSecrets,
  secretRefsIn,
  substituteSecrets,
} from "../plugin-egress";

/**
 * These are attacks, not examples.
 *
 * Every `it` here is something a published plugin could actually send, and each
 * one is a way an SSRF filter is bypassed in the wild. A test that only checked
 * that `https://api.deepl.com` is allowed and `http://evil.com` is not would pass
 * against a filter with all the interesting holes still in it.
 */

const ALLOW = ["api.deepl.com", "*.openai.com"];

describe("hostAllowed", () => {
  it("matches an exact host", () => {
    expect(hostAllowed("api.deepl.com", ALLOW)).toBe(true);
  });

  it("matches a wildcard's subdomain", () => {
    expect(hostAllowed("api.openai.com", ALLOW)).toBe(true);
  });

  it("does NOT let a wildcard match its own apex", () => {
    // `*.openai.com` is not `openai.com`. Two hosts, two decisions.
    expect(hostAllowed("openai.com", ALLOW)).toBe(false);
  });

  it("does NOT match a suffix that merely ends the same way", () => {
    // The classic. `evil-openai.com` ends with "openai.com" as a STRING, and a
    // filter comparing strings rather than labels hands the attacker the domain.
    expect(hostAllowed("evil-openai.com", ALLOW)).toBe(false);
    expect(hostAllowed("notapi.deepl.com", ALLOW)).toBe(false);
  });

  it("does NOT match a host that only contains the allowed one", () => {
    expect(hostAllowed("api.deepl.com.evil.tld", ALLOW)).toBe(false);
  });

  it("normalises case and the trailing root dot", () => {
    // `api.deepl.com.` is the same name to DNS. It must be the same name here, or
    // it is a host reachable without ever being declared.
    expect(hostAllowed("API.DEEPL.COM", ALLOW)).toBe(true);
    expect(hostAllowed("api.deepl.com.", ALLOW)).toBe(true);
  });

  it("allows nothing when the allowlist is empty", () => {
    expect(hostAllowed("api.deepl.com", [])).toBe(false);
  });
});

describe("isBlockedAddress", () => {
  it("blocks the cloud metadata endpoint", () => {
    // The one that turns an SSRF into stolen IAM credentials.
    expect(isBlockedAddress("169.254.169.254")).toBe(true);
  });

  it("blocks loopback, private and CGNAT ranges", () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "172.16.0.1", "192.168.1.1", "100.64.0.1"]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("blocks 0.0.0.0 and the broadcast address", () => {
    expect(isBlockedAddress("0.0.0.0")).toBe(true);
    expect(isBlockedAddress("255.255.255.255")).toBe(true);
  });

  it("blocks IPv4-mapped IPv6 loopback in both notations", () => {
    // ::ffff:127.0.0.1 IS 127.0.0.1. A check that consulted only the IPv6 rules
    // would wave it through, and this is the single commonest bypass there is.
    expect(isBlockedAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedAddress("::ffff:7f00:1")).toBe(true);
    expect(isBlockedAddress("::ffff:169.254.169.254")).toBe(true);
  });

  it("blocks IPv6 loopback, link-local and unique-local", () => {
    for (const ip of ["::1", "::", "fe80::1", "fd00::1", "64:ff9b::7f00:1"]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("allows an ordinary public address", () => {
    expect(isBlockedAddress("93.184.216.34")).toBe(false);
    expect(isBlockedAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(false);
  });

  it("refuses anything that is not an address at all", () => {
    // Fails closed: every caller of this dials a socket if it returns false.
    expect(isBlockedAddress("localhost")).toBe(true);
    expect(isBlockedAddress("")).toBe(true);
  });
});

describe("invalidHostDeclarations", () => {
  it("accepts real hostnames and a leading wildcard", () => {
    expect(invalidHostDeclarations(["api.deepl.com", "*.openai.com"])).toEqual([]);
  });

  it("refuses the open internet", () => {
    expect(invalidHostDeclarations(["*"])).toEqual(["*"]);
  });

  it("refuses IP literals, ports, schemes and paths", () => {
    const bad = ["127.0.0.1", "api.deepl.com:8080", "https://api.deepl.com", "host.com/path"];
    expect(invalidHostDeclarations(bad)).toEqual(bad);
  });

  it("refuses names that resolve inside the network", () => {
    expect(invalidHostDeclarations(["localhost", "db.local"])).toEqual(["localhost", "db.local"]);
  });
});

describe("parseAndCheckUrl", () => {
  it("accepts an allowlisted https URL", () => {
    expect(parseAndCheckUrl("https://api.deepl.com/v2/translate", ALLOW).hostname).toBe(
      "api.deepl.com",
    );
  });

  it("refuses a host outside the allowlist", () => {
    expect(() => parseAndCheckUrl("https://evil.com/", ALLOW)).toThrow(EgressRefused);
  });

  it("refuses plaintext http", () => {
    // The admin's credential rides on this request. In the clear it would be the
    // admin's credential on someone else's wire.
    expect(() => parseAndCheckUrl("http://api.deepl.com/", ALLOW)).toThrow(/only speaks https/);
  });

  it("refuses non-http schemes outright", () => {
    for (const url of ["file:///etc/passwd", "gopher://api.deepl.com/", "data:text/plain,hi"]) {
      expect(() => parseAndCheckUrl(url, ALLOW), url).toThrow(EgressRefused);
    }
  });

  it("refuses credentials smuggled into the authority", () => {
    // `https://api.deepl.com@evil.com/` — the host is evil.com, and a filter that
    // string-matched the URL rather than parsing it would read "api.deepl.com".
    expect(() => parseAndCheckUrl("https://api.deepl.com@evil.com/", ALLOW)).toThrow(
      EgressRefused,
    );
  });

  it("refuses a non-443 port", () => {
    expect(() => parseAndCheckUrl("https://api.deepl.com:8500/", ALLOW)).toThrow(/port 443/);
  });
});

describe("secrets", () => {
  const secrets = { apiKey: "sk-live-abcdef123456" };

  it("substitutes into a header without the plugin seeing the value", () => {
    const req = prepareRequest(
      {
        url: "https://api.deepl.com/v2/translate",
        method: "POST",
        headers: { authorization: "DeepL-Auth-Key {{secret:apiKey}}" },
        body: { text: "hello" },
      },
      ALLOW,
      secrets,
    );
    expect(req.headers.authorization).toBe("DeepL-Auth-Key sk-live-abcdef123456");
    expect(req.headers["content-type"]).toBe("application/json");
  });

  it("refuses a secret the manifest never declared", () => {
    expect(() =>
      prepareRequest(
        { url: "https://api.deepl.com/", headers: { x: "{{secret:other}}" } },
        ALLOW,
        secrets,
      ),
    ).toThrow(/network\.secrets/);
  });

  it("substitutes into the URL BEFORE the host is checked", () => {
    // The attack: write the secret where the hostname goes. If the host check ran
    // on the un-substituted string it would validate "{{secret:apiKey}}" — a
    // hostname that does not exist by the time we dial. Substituting first means
    // the host we judge is the host we connect to.
    expect(() =>
      prepareRequest({ url: "https://{{secret:apiKey}}/" }, ALLOW, secrets),
    ).toThrow(EgressRefused);
  });

  it("keeps a secret out of the error it causes", () => {
    // ...and this is why the message is redacted: the refusal above names the
    // hostname it refused, and the hostname WAS the key.
    let message = "";
    try {
      prepareRequest({ url: "https://{{secret:apiKey}}/" }, ALLOW, secrets);
    } catch (err) {
      message = redactSecrets((err as Error).message, secrets);
    }
    expect(message).not.toContain("sk-live-abcdef123456");
    expect(message).toContain("«secret»");
  });

  it("url-encodes a secret substituted into a query string", () => {
    const req = prepareRequest(
      { url: "https://api.deepl.com/v1?key={{secret:apiKey}}&q=x" },
      ALLOW,
      { apiKey: "a&b=c" },
    );
    // Unencoded, "a&b=c" would introduce a query parameter of its own.
    expect(req.url).toContain("key=a%26b%3Dc");
    expect(new URL(req.url).searchParams.get("q")).toBe("x");
  });

  it("finds every reference so unset ones can be reported before sending", () => {
    expect(secretRefsIn('{"h":"{{secret:a}}","b":"{{secret:b}}"}')).toEqual(["a", "b"]);
  });

  it("does not shred a message when a secret is trivially short", () => {
    expect(redactSecrets("nothing to see", { k: "ab" })).toBe("nothing to see");
  });

  it("leaves text with no references untouched", () => {
    expect(substituteSecrets("plain text", secrets)).toBe("plain text");
  });
});

describe("prepareRequest", () => {
  it("refuses a method that is not a method", () => {
    expect(() => prepareRequest({ url: "https://api.deepl.com/", method: "TRACE" }, ALLOW, {}))
      .toThrow(/cannot use the method/);
  });

  it("refuses headers that describe the connection rather than the message", () => {
    // `Host` is the dangerous one: it would let a plugin reach one server while
    // the allowlist checked another.
    for (const name of ["host", "content-length", "transfer-encoding", "connection"]) {
      expect(
        () => prepareRequest({ url: "https://api.deepl.com/", headers: { [name]: "x" } }, ALLOW, {}),
        name,
      ).toThrow(EgressRefused);
    }
  });

  it("refuses a header value carrying a line break", () => {
    // Request splitting: everything after the CRLF is read as a header of its own.
    expect(() =>
      prepareRequest(
        { url: "https://api.deepl.com/", headers: { "x-a": "ok\r\nX-Injected: 1" } },
        ALLOW,
        {},
      ),
    ).toThrow(/line break/);
  });

  it("refuses a body over the size limit", () => {
    expect(() =>
      prepareRequest(
        { url: "https://api.deepl.com/", method: "POST", body: "x".repeat(300 * 1024) },
        ALLOW,
        {},
      ),
    ).toThrow(/larger than/);
  });

  it("drops the body on a GET", () => {
    const req = prepareRequest(
      { url: "https://api.deepl.com/", method: "GET", body: "ignored" },
      ALLOW,
      {},
    );
    expect(req.body).toBeUndefined();
  });

  it("needs a url", () => {
    expect(() => prepareRequest({}, ALLOW, {})).toThrow(/needs a url/);
  });
});

describe("exposeResponseHeaders", () => {
  it("passes through the headers a plugin has a use for", () => {
    const out = exposeResponseHeaders({ "content-type": "application/json", etag: "abc" });
    expect(out).toEqual({ "content-type": "application/json", etag: "abc" });
  });

  it("withholds set-cookie", () => {
    // A session cookie for a service the ADMIN's credential just authenticated to
    // would be a way to keep using that credential after we stopped lending it.
    const out = exposeResponseHeaders({
      "set-cookie": "session=abc",
      "content-type": "text/plain",
    });
    expect(out["set-cookie"]).toBeUndefined();
    expect(out["content-type"]).toBe("text/plain");
  });
});
