import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The security event recorder.
 *
 * Two contracts are load-bearing and both are about NOT breaking the request:
 *   - `record()` is fire-and-forget — a failure to write an audit row, or an
 *     alert webhook being down, must never turn a 403 into a 500. If it could, an
 *     attacker who can make the audit sink fail could also DoS the endpoint that
 *     was about to deny them.
 *   - the row it writes has the shape the operator needs (tenant, actor, action,
 *     ip), and ALERTING events additionally fire the webhook.
 *
 * Prisma and `fetch` are mocked; the point is which calls happen, and that a
 * throw in either is swallowed.
 */

const dbState = vi.hoisted(() => ({ auditLog: { create: vi.fn() } }));
vi.mock("@zcmsorg/database", () => ({ getSystemDb: () => dbState }));

import { SecurityEventService } from "../security-event.service";

function makeService(env: Record<string, string> = {}) {
  const config = { get: (key: string) => env[key] } as any;
  return new SecurityEventService(config);
}

/** record() never awaits its write; give the microtasks a turn to settle. */
async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("SecurityEventService", () => {
  beforeEach(() => {
    dbState.auditLog.create.mockReset().mockResolvedValue({});
    vi.restoreAllMocks();
  });

  describe("record", () => {
    it("writes an audit row with the actor, tenant, action and ip", async () => {
      const service = makeService();

      service.record("auth.permission_denied", {
        userId: "user-1",
        tenantId: "tenant-1",
        siteId: "site-1",
        ip: "1.2.3.4",
      });
      await settle();

      expect(dbState.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tenantId: "tenant-1",
          actorId: "user-1",
          siteId: "site-1",
          action: "auth.permission_denied",
          resourceType: "security",
          ip: "1.2.3.4",
        }),
      });
    });

    it("returns synchronously without waiting for the write", () => {
      // It runs in the AuthGuard on the hot path; awaiting a DB write there would
      // add a round trip to every denied request.
      const service = makeService();

      const returned = service.record("auth.permission_denied", { tenantId: "t" });

      expect(returned).toBeUndefined();
    });

    it("does not throw into the caller when the audit write fails", async () => {
      // The key property. A denied request must still be denied cleanly even if
      // the audit sink is down — otherwise breaking the sink breaks the gate.
      dbState.auditLog.create.mockRejectedValue(new Error("db is down"));
      const service = makeService();

      expect(() =>
        service.record("auth.permission_denied", { tenantId: "tenant-1" }),
      ).not.toThrow();
      await settle(); // the rejection is caught internally, not surfaced
    });

    it("skips the audit row when there is no tenant to attribute it to", async () => {
      // The audit table is tenant-scoped; a tenant-less event (e.g. a failed login
      // for an unknown email) has nowhere to be filed and must not write a null.
      const service = makeService();

      service.record("auth.login_failed", { ip: "1.2.3.4" });
      await settle();

      expect(dbState.auditLog.create).not.toHaveBeenCalled();
    });

    it("fires the alert webhook for an ALERTING event", async () => {
      // A stolen-session replay is not just a row; someone should be told. The
      // webhook is the "told" part.
      const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const service = makeService({ SECURITY_ALERT_WEBHOOK: "https://hook.example.test" });

      service.record("auth.session_theft_detected", {
        tenantId: "tenant-1",
        userId: "user-1",
      });
      await settle();

      expect(fetchMock).toHaveBeenCalledWith(
        "https://hook.example.test",
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("does not fire the webhook for an ordinary, non-alerting event", async () => {
      const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const service = makeService({ SECURITY_ALERT_WEBHOOK: "https://hook.example.test" });

      service.record("auth.permission_denied", { tenantId: "tenant-1" });
      await settle();

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does not throw when the alert webhook itself fails", async () => {
      // An incident tool being unreachable must not take down the request that was
      // reporting the incident.
      const fetchMock = vi.fn(async () => {
        throw new Error("webhook unreachable");
      });
      vi.stubGlobal("fetch", fetchMock);
      const service = makeService({ SECURITY_ALERT_WEBHOOK: "https://hook.example.test" });

      expect(() =>
        service.record("auth.session_theft_detected", { tenantId: "tenant-1" }),
      ).not.toThrow();
      await settle();
    });

    it("records an alerting event even with no webhook configured, without failing", async () => {
      // The log line is the floor: an operator reading logs must learn a session
      // was stolen without having first configured a webhook.
      const service = makeService({}); // no SECURITY_ALERT_WEBHOOK

      service.record("auth.session_theft_detected", {
        tenantId: "tenant-1",
        userId: "user-1",
      });
      await settle();

      expect(dbState.auditLog.create).toHaveBeenCalled();
    });
  });
});
