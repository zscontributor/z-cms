import { JwtService } from "@nestjs/jwt";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PluginTokenService, type PluginTokenClaims } from "../plugin-token.service";

/**
 * The short-lived credential a plugin runs under.
 *
 * Real JWT signing throughout. The properties that make this safe to hand into a
 * sandbox:
 *   - the scopes travel IN the token, signed, so the gateway never trusts a
 *     plugin's word about what it may do;
 *   - a plugin cannot forge or replay a token for a DIFFERENT plugin;
 *   - it is signed with a key separate from user tokens, so it can never be
 *     replayed as a user session, nor the reverse;
 *   - it expires in seconds.
 */

const JWT_SECRET = "test-jwt-secret";
const PLUGIN_SECRET = `${JWT_SECRET}:plugin`;

function makeService() {
  const config = {
    getOrThrow: (key: string) => {
      if (key !== "JWT_SECRET") throw new Error(`missing ${key}`);
      return JWT_SECRET;
    },
    // No Redis in this unit test: the lazyConnect client never opens a socket,
    // and the retirement check fails open, so mint/verify round-trip unaffected.
    get: () => undefined,
  } as any;
  return new PluginTokenService(new JwtService(), config);
}

const CLAIMS: PluginTokenClaims = {
  plg: "vn.zsoft.plugin.seo",
  pid: "plugin-row-1",
  tid: "tenant-1",
  sid: "site-1",
  scopes: ["content:read", "content:update"],
};

describe("PluginTokenService", () => {
  let service: PluginTokenService;

  beforeEach(() => {
    service = makeService();
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  describe("mint / verify", () => {
    it("round-trips the claims it was given", async () => {
      const { token } = await service.mint(CLAIMS);

      const verified = await service.verify(token);

      expect(verified).toMatchObject(CLAIMS);
    });

    it("carries the plugin's own id and only the scopes it was granted", async () => {
      // The gateway reads authority from here, not from the plugin. If a token for
      // the SEO plugin could carry a different plugin's id or extra scopes, a
      // compromised plugin would act as another.
      const { token } = await service.mint(CLAIMS);

      const verified = await service.verify(token);

      expect(verified.pid).toBe("plugin-row-1");
      expect(verified.plg).toBe("vn.zsoft.plugin.seo");
      expect(verified.scopes).toEqual(["content:read", "content:update"]);
      expect(verified.scopes).not.toContain("user:manage");
    });

    it("refuses a token a plugin forged with its own key to impersonate another", async () => {
      // FORGERY / IMPERSONATION. A plugin that mints its own token — naming another
      // plugin and broad scopes — has no signing key, so the gateway must reject it.
      const forged = await new JwtService().signAsync(
        { ...CLAIMS, plg: "vn.zsoft.plugin.evil", scopes: ["user:manage"] },
        { secret: "the-plugins-own-guess", expiresIn: "60s" },
      );

      await expect(service.verify(forged)).rejects.toThrow();
    });

    it("refuses a token signed with the USER access secret", async () => {
      // KEY SEPARATION. A leaked user token must not double as a plugin credential.
      const asUserToken = await new JwtService().signAsync(CLAIMS, {
        secret: JWT_SECRET,
        expiresIn: "60s",
      });

      await expect(service.verify(asUserToken)).rejects.toThrow();
    });

    it("refuses an expired plugin token", async () => {
      // The blast radius of a stolen plugin token is bounded by its seconds-long
      // life. If expiry were not enforced, that bound is gone.
      const expired = await new JwtService().signAsync(CLAIMS, {
        secret: PLUGIN_SECRET,
        expiresIn: "-1s",
      });

      await expect(service.verify(expired)).rejects.toThrow();
    });

    it("mints a token that expires, rather than one that lives forever", async () => {
      const { token } = await service.mint(CLAIMS);

      const decoded = await service.verify(token);

      expect(decoded).toHaveProperty("exp");
      const lifetimeSec = (decoded as any).exp - (decoded as any).iat;
      expect(lifetimeSec).toBeLessThanOrEqual(60);
      expect(lifetimeSec).toBeGreaterThan(0);
    });

    it("refuses a garbage string", async () => {
      await expect(service.verify("not.a.jwt")).rejects.toThrow();
    });

    it("refuses a token whose payload was edited to widen its scopes", async () => {
      // Take a genuine token, splice `user:manage` into the scopes, keep the
      // signature. The signature covers the payload, so it must no longer verify.
      const { token } = await service.mint(CLAIMS);
      const [header, , signature] = token.split(".");
      const widened = Buffer.from(
        JSON.stringify({ ...CLAIMS, scopes: ["user:manage"] }),
      ).toString("base64url");

      await expect(service.verify(`${header}.${widened}.${signature}`)).rejects.toThrow();
    });
  });
});
