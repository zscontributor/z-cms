import { beforeEach, describe, expect, it, vi } from "vitest";
import { runMarketplaceSync } from "../marketplace-sync";

/**
 * The worker is the CLOCK for the kill switch, not the brain: it triggers the
 * hourly revocation sync but does NOT itself verify signatures or write local
 * state — cms-api holds the pinned marketplace key and owns the machinery. These
 * tests pin that contract: the worker must call cms-api with the internal token,
 * must never fabricate a "sync applied" result on its own, and must surface a
 * failure loudly enough that BullMQ retries our own unreachable API.
 */

/** A fake Response good enough for the two fields the job reads. */
function fakeResponse(
  init: { ok: boolean; status?: number; json?: unknown; text?: string },
): Response {
  return {
    ok: init.ok,
    status: init.status ?? (init.ok ? 200 : 500),
    json: async () => init.json,
    text: async () => init.text ?? "",
  } as Response;
}

describe("runMarketplaceSync", () => {
  beforeEach(() => {
    vi.stubEnv("CMS_API_URL", "http://cms-api:4100");
    vi.stubEnv("CMS_INTERNAL_TOKEN", "s3cr3t-internal");
  });

  it("asks cms-api to run the sync rather than verifying the list itself", async () => {
    // The worker holds no marketplace public key. If this test ever finds a DB or
    // crypto import doing the work here, the kill switch has grown a second, rotting
    // enforcement path — the exact thing the design forbids.
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ ok: true, json: { ok: true, applied: 2 } }));
    vi.stubGlobal("fetch", fetchMock);

    await runMarketplaceSync();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://cms-api:4100/api/v1/marketplace/sync");
    expect(options.method).toBe("POST");
  });

  it("presents the internal token so cms-api can tell this call from a public one", async () => {
    // Without the shared secret, the internal sync endpoint would have to trust the
    // network. This header is what proves the caller is our own worker.
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ ok: true, json: { ok: true, applied: 0 } }));
    vi.stubGlobal("fetch", fetchMock);

    await runMarketplaceSync();

    const options = fetchMock.mock.calls[0]![1];
    expect(options.headers["x-internal-token"]).toBe("s3cr3t-internal");
  });

  it("returns whatever cms-api reports, without inventing a success", async () => {
    // The count of applied revocations is the ground truth the admin surfaces. The
    // worker must pass it through, not synthesise it.
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ ok: true, json: { ok: true, applied: 5 } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await runMarketplaceSync();

    expect(result).toEqual({ ok: true, applied: 5 });
  });

  it("throws on a non-2xx from cms-api so BullMQ retries our own unreachable API", async () => {
    // A 500 from cms-api is OUR process failing, not the marketplace being down —
    // exactly the case worth a retry. Swallowing it would silently freeze the kill
    // switch while a revoked, malicious package keeps executing on live sites.
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({ ok: false, status: 503, text: "upstream down" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(runMarketplaceSync()).rejects.toThrow(/HTTP 503/);
  });

  it("strips trailing slashes off CMS_API_URL so the path is never doubled", async () => {
    // A misconfigured "http://cms-api:4100/" would otherwise POST to "...//api/v1/..."
    // — a 404 that quietly disables the hourly kill-switch sync.
    vi.stubEnv("CMS_API_URL", "http://cms-api:4100///");
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ ok: true, json: { ok: true, applied: 0 } }));
    vi.stubGlobal("fetch", fetchMock);

    await runMarketplaceSync();

    expect(fetchMock.mock.calls[0]![0]).toBe("http://cms-api:4100/api/v1/marketplace/sync");
  });

  it("falls back to the local cms-api and an empty token when the env is unset", async () => {
    // A dev machine with no CMS_API_URL/CMS_INTERNAL_TOKEN must still target the local
    // API rather than throw on a missing env — the worker has to boot in development.
    vi.stubEnv("CMS_API_URL", undefined);
    vi.stubEnv("CMS_INTERNAL_TOKEN", undefined);
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ ok: true, json: { ok: true, applied: 0 } }));
    vi.stubGlobal("fetch", fetchMock);

    await runMarketplaceSync();

    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://localhost:4100/api/v1/marketplace/sync");
    expect(options.headers["x-internal-token"]).toBe("");
  });

  it("propagates a network error as a rejection, not a fabricated ok:false", async () => {
    // fetch rejecting (DNS/connection refused) must bubble up as a failed job. If it
    // were caught and reported as a clean result, a total outage would look healthy.
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(runMarketplaceSync()).rejects.toThrow(/ECONNREFUSED/);
  });
});
