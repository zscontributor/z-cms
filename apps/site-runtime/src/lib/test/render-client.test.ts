import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The single seam between site-runtime and cms-api. It decides auth, caching and
 * failure policy once, for every page. The behaviours that matter to a visitor:
 * an unknown domain renders a clean 404 (null) not a 500; the API being down or
 * lying does not crash the document shell; and the internal token is always sent
 * so a page can actually be resolved.
 */

// React's `cache` memoises per request scope; outside one it is a no-op passthrough.
vi.mock("react", async (importActual) => {
  const actual = await importActual<typeof import("react")>();
  return { ...actual, cache: <T>(fn: T) => fn };
});

const headerStore = new Map<string, string>();
vi.mock("next/headers", () => ({
  headers: async () => ({ get: (k: string) => headerStore.get(k.toLowerCase()) ?? null }),
}));

import {
  currentHostname,
  parsePageParam,
  RenderApiError,
  resolveDocumentLocale,
  resolveRender,
} from "../render-client";

const TOKEN = "internal-token";

/** Builds a fetch stub returning one canned Response, and records the call. */
function stubFetch(response: Response | Error) {
  const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
    if (response instanceof Error) throw response;
    return response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  headerStore.clear();
  vi.stubEnv("CMS_API_URL", "http://api.internal:4100");
  vi.stubEnv("CMS_INTERNAL_TOKEN", TOKEN);
});

describe("resolveRender", () => {
  it("returns null for an empty hostname without calling the API", async () => {
    const fetchMock = stubFetch(jsonResponse({}));

    expect(await resolveRender("", "/", 1)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null when the API 404s an unknown domain (a 404 page, never a 500)", async () => {
    // A domain that points here but is not configured must not become an outage.
    stubFetch(jsonResponse({ message: "no site" }, 404));

    expect(await resolveRender("nope.example", "/", 1)).toBeNull();
  });

  it("sends the internal token so the render endpoint accepts the call", async () => {
    const fetchMock = stubFetch(jsonResponse({ ok: true }));

    await resolveRender("site.test", "/", 1);

    const init = fetchMock.mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string>)["X-Internal-Token"]).toBe(TOKEN);
  });

  it("passes the search query through only for the search route", async () => {
    const fetchMock = stubFetch(jsonResponse({ ok: true }));

    await resolveRender("site.test", "/search", 1, " cms ");

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("path")).toBe("/search");
    expect(url.searchParams.get("q")).toBe("cms");
  });

  it("tags the fetch so cms-api can purge exactly this page", async () => {
    const fetchMock = stubFetch(jsonResponse({ ok: true }));

    await resolveRender("site.test", "/blog", 1);

    const init = fetchMock.mock.calls[0]?.[1] as (RequestInit & { next?: { tags?: string[] } }) | undefined;
    expect(init?.next?.tags).toContain("page:site.test:/blog");
    expect(init?.next?.tags).toContain("site:site.test");
  });

  it("returns the parsed payload on a 200", async () => {
    stubFetch(jsonResponse({ site: { locale: "en" } }));

    const payload = await resolveRender("site.test", "/", 1);

    expect(payload).toEqual({ site: { locale: "en" } });
  });

  it("throws a 502 RenderApiError when cms-api is unreachable", async () => {
    // A network failure is distinguishable from a bad response: callers upstream
    // turn a 502 into the right error page, not a blank crash.
    stubFetch(new Error("ECONNREFUSED"));

    await expect(resolveRender("site.test", "/", 1)).rejects.toBeInstanceOf(RenderApiError);
    await expect(resolveRender("site.test", "/", 1)).rejects.toMatchObject({ status: 502 });
  });

  it("throws a RenderApiError carrying the upstream status on a non-2xx", async () => {
    stubFetch(jsonResponse({ message: "boom" }, 503));

    await expect(resolveRender("site.test", "/", 1)).rejects.toMatchObject({
      status: 503,
    });
  });
});

describe("currentHostname", () => {
  it("prefers x-forwarded-host (the real domain behind a proxy)", async () => {
    headerStore.set("x-forwarded-host", "Public.Example");
    headerStore.set("host", "internal:3000");

    expect(await currentHostname()).toBe("public.example");
  });

  it("falls back to the Host header and lowercases it", async () => {
    headerStore.set("host", "Site.Test");

    expect(await currentHostname()).toBe("site.test");
  });

  it("is the empty string when no host header is present", async () => {
    expect(await currentHostname()).toBe("");
  });
});

describe("parsePageParam", () => {
  it("parses a positive page number", () => {
    expect(parsePageParam("3")).toBe(3);
  });

  it("takes the first value of an array", () => {
    expect(parsePageParam(["2", "5"])).toBe(2);
  });

  it("defaults nonsense, zero and negatives to page 1", () => {
    // Hostile ?page= must never become a negative offset or NaN downstream.
    expect(parsePageParam(undefined)).toBe(1);
    expect(parsePageParam("abc")).toBe(1);
    expect(parsePageParam("0")).toBe(1);
    expect(parsePageParam("-4")).toBe(1);
  });
});

describe("resolveDocumentLocale", () => {
  it("returns the site's locale and direction from the resolved payload", async () => {
    headerStore.set("x-pathname", "/blog");
    headerStore.set("x-search", "");
    stubFetch(jsonResponse({ site: { locale: "en" } }));

    expect(await resolveDocumentLocale()).toEqual({ lang: "en", dir: "ltr" });
  });

  it("degrades to the base locale instead of crashing when the API is down", async () => {
    // The document shell must render even if cms-api is unreachable; a failed
    // <html lang> lookup must not take the whole page down.
    headerStore.set("x-pathname", "/");
    stubFetch(new Error("ECONNREFUSED"));

    expect(await resolveDocumentLocale()).toEqual({ lang: "en", dir: "ltr" });
  });

  it("falls back to the base locale when the payload carries no locale", async () => {
    headerStore.set("x-pathname", "/");
    stubFetch(jsonResponse({ site: {} }));

    expect(await resolveDocumentLocale()).toEqual({ lang: "en", dir: "ltr" });
  });
});
