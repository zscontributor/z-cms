import { beforeEach, describe, expect, it, vi } from "vitest";
import { runPluginDeferred } from "../plugin-deferred";

/**
 * The worker holds S3 and DB credentials, so a plugin's code must never execute
 * inside it. A deferred plugin job is therefore a callback to cms-api, which runs
 * the plugin in the isolated-vm sandbox under its scoped token. These tests pin
 * that the worker only "pulls the trigger": it forwards the scope, it does not
 * broaden it, and a failing plugin becomes a retried job — never a worker crash.
 */

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

const PAYLOAD = {
  tenantId: "t-1",
  siteId: "s-1",
  pluginKey: "vn.zsoft.plugin.seo",
  name: "reindex",
  payload: { postId: "p-1" },
};

describe("runPluginDeferred", () => {
  beforeEach(() => {
    vi.stubEnv("CMS_API_URL", "http://cms-api:4100");
    vi.stubEnv("CMS_INTERNAL_TOKEN", "s3cr3t-internal");
  });

  it("dispatches to the plugin gateway instead of running plugin code in the worker", async () => {
    // If this ever stopped being a plain fetch to cms-api, plugin code would be one
    // step from executing next to the worker's S3 and DB credentials.
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ ok: true, json: { ok: true } }));
    vi.stubGlobal("fetch", fetchMock);

    await runPluginDeferred(PAYLOAD);

    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://cms-api:4100/api/v1/plugin-gateway/run-job");
    expect(options.method).toBe("POST");
    expect(options.headers["x-internal-token"]).toBe("s3cr3t-internal");
  });

  it("forwards the tenant, site and plugin identity so cms-api re-derives the scope", async () => {
    // The sandbox scopes the plugin's token by (tenant, site, pluginKey). Dropping or
    // swapping any of these would let a plugin act in the wrong tenant's scope.
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ ok: true, json: { ok: true } }));
    vi.stubGlobal("fetch", fetchMock);

    await runPluginDeferred(PAYLOAD);

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body).toEqual({
      tenantId: "t-1",
      siteId: "s-1",
      pluginKey: "vn.zsoft.plugin.seo",
      name: "reindex",
      payload: { postId: "p-1" },
    });
  });

  it("keeps the plugin's handler name separate from the plugin key it forwards", async () => {
    // `pluginKey` is what the runtime sandboxes; `name` is an opaque string the PLUGIN
    // chose. A hostile plugin that named its handler after a first-party job must not
    // be able to make the worker (or gateway) treat it as one — the two travel in
    // distinct fields, never collapsed.
    const hostile = { ...PAYLOAD, pluginKey: "vn.evil.plugin", name: "media.variants" };
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ ok: true, json: { ok: true } }));
    vi.stubGlobal("fetch", fetchMock);

    await runPluginDeferred(hostile);

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.pluginKey).toBe("vn.evil.plugin");
    expect(body.name).toBe("media.variants");
    expect(body.pluginKey).not.toBe(body.name);
  });

  it("throws on a non-2xx so the job is retried with backoff, not silently dropped", async () => {
    // A plugin that fails transiently deserves another attempt; one that always fails
    // must exhaust its attempts and land in the failed set. Both require the handler to
    // throw here rather than return a clean result.
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({ ok: false, status: 500, text: "plugin threw" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(runPluginDeferred(PAYLOAD)).rejects.toThrow(/HTTP 500/);
  });

  it("names the failing plugin and handler in the error so a dead letter is diagnosable", async () => {
    // When this lands in the failed set an operator needs to know WHICH plugin broke.
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({ ok: false, status: 502, text: "bad gateway" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(runPluginDeferred(PAYLOAD)).rejects.toThrow(/vn\.zsoft\.plugin\.seo\/reindex/);
  });

  it("falls back to the local cms-api and an empty token when the env is unset", async () => {
    // The worker must boot in development with no CMS_API_URL/CMS_INTERNAL_TOKEN set.
    vi.stubEnv("CMS_API_URL", undefined);
    vi.stubEnv("CMS_INTERNAL_TOKEN", undefined);
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ ok: true, json: { ok: true } }));
    vi.stubGlobal("fetch", fetchMock);

    await runPluginDeferred(PAYLOAD);

    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://localhost:4100/api/v1/plugin-gateway/run-job");
    expect(options.headers["x-internal-token"]).toBe("");
  });

  it("returns the gateway's result on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({ ok: true, json: { ok: false, error: "plugin reported failure" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await runPluginDeferred(PAYLOAD);

    expect(result).toEqual({ ok: false, error: "plugin reported failure" });
  });
});
