import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { callGateway } from "../gateway-client";

/**
 * The one door out of the sandbox. A plugin has no socket and no token; it posts
 * an RPC, and THIS module makes the real call to cms-api carrying the plugin's
 * scoped token. The trust boundary is cms-api on the far side — so the two things
 * that matter here are (1) the token actually goes with the request, and (2) a
 * hostile or broken gateway response is surfaced as an error, not swallowed into
 * a "success" the sandbox then trusts.
 *
 * Only the network (`fetch`) is mocked — that is the boundary, and the only thing
 * this module talks to.
 */

const originalFetch = globalThis.fetch;

beforeEach(() => {
  process.env.CMS_API_URL = "http://cms-api.internal:4100";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** Installs a fetch stub and returns the mock so tests can inspect the call. */
function stubFetch(response: Partial<Response> & { jsonBody?: unknown }) {
  const fetchMock = vi.fn(async () => ({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    json: async () => response.jsonBody ?? {},
  })) as unknown as typeof fetch;
  globalThis.fetch = fetchMock;
  return fetchMock as unknown as ReturnType<typeof vi.fn>;
}

describe("callGateway", () => {
  it("sends the plugin's scoped token as a bearer credential", async () => {
    // cms-api decides what a plugin may do from THIS token. If it were dropped, the
    // gateway would either reject everything or (worse) act without an identity.
    const fetchMock = stubFetch({ jsonBody: { data: { ok: true } } });

    await callGateway("scoped-token-123", "storage.get", { key: "x" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer scoped-token-123",
    );
  });

  it("posts the method and params as the request body to the plugin gateway", async () => {
    const fetchMock = stubFetch({ jsonBody: { data: null } });

    await callGateway("t", "content.list", { query: { type: "post" } });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://cms-api.internal:4100/api/v1/plugin-gateway/call");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      method: "content.list",
      params: { query: { type: "post" } },
    });
  });

  it("returns only the data field of the response, not the whole envelope", async () => {
    // The plugin must see the payload, never the transport envelope (status/message).
    stubFetch({ jsonBody: { data: { value: 42 }, message: "ok" } });

    const result = await callGateway("t", "storage.get", { key: "answer" });

    expect(result).toEqual({ value: 42 });
  });

  it("throws when the gateway returns a non-2xx status instead of swallowing it", async () => {
    // A denied scope comes back as an error status. If this were swallowed, a plugin
    // whose request was REFUSED would see a silent success and act on nothing.
    stubFetch({ ok: false, status: 403, jsonBody: { message: "scope not granted" } });

    await expect(callGateway("t", "storage.set", { key: "x", value: 1 })).rejects.toThrow(
      /scope not granted/,
    );
  });

  it("still throws on a non-2xx even when the error body has no message", async () => {
    // A broken gateway may return an error status with an empty body. The runtime
    // must not read that as success; it falls back to a status-bearing message.
    stubFetch({ ok: false, status: 500, jsonBody: {} });

    await expect(callGateway("t", "jobs.enqueue", {})).rejects.toThrow(/HTTP 500/);
  });

  it("does not crash when a compromised gateway returns non-JSON garbage", async () => {
    // A hostile gateway could reply with a body that is not JSON. Parsing must fail
    // soft (treated as an empty object), not throw an unhandled error into the host.
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    })) as unknown as typeof fetch;

    const result = await callGateway("t", "storage.get", { key: "x" });

    // No `data` field survived the garbage, so the plugin gets nothing — not junk.
    expect(result).toBeUndefined();
  });

  it("propagates a network timeout as a rejection rather than hanging", async () => {
    // fetch is given an AbortSignal.timeout; when it fires, fetch rejects. That
    // rejection must reach the caller so the RPC fails instead of hanging forever.
    globalThis.fetch = vi.fn(async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as unknown as typeof fetch;

    await expect(callGateway("t", "storage.get", { key: "x" })).rejects.toThrow(
      /timed out/,
    );
  });

  it("falls back to the local cms-api URL when none is configured", async () => {
    // A missing CMS_API_URL must not mean "call nothing"; it defaults to the local
    // gateway so a misconfigured env fails loudly against a real endpoint.
    delete process.env.CMS_API_URL;
    const fetchMock = stubFetch({ jsonBody: { data: null } });

    await callGateway("t", "storage.get", {});

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("http://localhost:4100/api/v1/plugin-gateway/call");
  });

  it("targets the configured cms-api URL with any trailing slashes stripped", async () => {
    // A trailing slash in config must not produce a double-slash path that the
    // gateway 404s on.
    process.env.CMS_API_URL = "http://cms-api.internal:4100///";
    const fetchMock = stubFetch({ jsonBody: { data: null } });

    await callGateway("t", "storage.get", {});

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("http://cms-api.internal:4100/api/v1/plugin-gateway/call");
  });
});
