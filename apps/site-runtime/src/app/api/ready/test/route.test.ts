import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveTheme = vi.fn();
vi.mock("@/lib/theme-registry", () => ({
  resolveTheme: (...args: unknown[]) => resolveTheme(...args),
}));

import { GET } from "../route";

const payload = {
  theme: {
    key: "vn.zsoft.theme.zsoft",
    version: "1.4.44",
    origin: "MARKETPLACE",
  },
};

beforeEach(() => {
  vi.restoreAllMocks();
  resolveTheme.mockReset();
  vi.stubEnv("READINESS_HOST", "z-cms.org");
  vi.stubEnv("CMS_API_URL", "http://cms-api:4100");
  vi.stubEnv("CMS_INTERNAL_TOKEN", "render-token");
});

describe("GET", () => {
  it("fails closed when no production hostname is configured", async () => {
    vi.stubEnv("READINESS_HOST", "");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const response = await GET();

    expect(response.status).toBe(503);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(resolveTheme).not.toHaveBeenCalled();
  });

  it("requires cms-api to resolve the live production tenant", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 404 }),
    );

    const response = await GET();

    expect(response.status).toBe(503);
    expect(resolveTheme).not.toHaveBeenCalled();
  });

  it("uses a no-store authenticated resolve instead of a warm Next cache hit", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(payload),
    );
    resolveTheme.mockResolvedValue({ degraded: false });

    const response = await GET();
    const [url, init] = fetchSpy.mock.calls[0] as [URL, RequestInit];

    expect(response.status).toBe(200);
    expect(url.toString()).toBe(
      "http://cms-api:4100/api/v1/render/resolve?hostname=z-cms.org&path=%2F&page=1",
    );
    expect(init.cache).toBe("no-store");
    expect(new Headers(init.headers).get("X-Internal-Token")).toBe("render-token");
  });

  it("pre-warms the active signed theme before reporting ready", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(payload));
    resolveTheme.mockResolvedValue({ degraded: false });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(resolveTheme).toHaveBeenCalledWith(
      "vn.zsoft.theme.zsoft",
      "1.4.44",
      "MARKETPLACE",
    );
  });

  it("does not report ready when theme loading degraded to the fallback", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(payload));
    resolveTheme.mockResolvedValue({ degraded: true });

    const response = await GET();

    expect(response.status).toBe(503);
  });

  it("returns 503 when the live resolve or theme pre-warm throws", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("api unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await GET();

    expect(response.status).toBe(503);
  });
});
