import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE, SITE_COOKIE } from "../cookies";
import { LOCALE_COOKIE } from "../locale";

// The request-scoped cookie store the mocked next/headers reads and writes.
const { cookieJar } = vi.hoisted(() => ({ cookieJar: new Map<string, string>() }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string) => {
      cookieJar.set(name, value);
    },
    delete: (name: string) => {
      cookieJar.delete(name);
    },
  }),
}));

// `cache` wraps the session/site helpers; in a test there is no React request to
// memoise against, so it degrades to calling the function through.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: <T>(fn: T) => fn };
});

import { ApiError, ForbiddenError, UnauthenticatedError, apiFetch } from "../api";

/** A ready-made JSON Response, since apiFetch reads `.text()` then parses. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(body === undefined ? "" : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  cookieJar.clear();
  // A site is pre-selected so site-scoped calls do not fan out into listSites().
  cookieJar.set(SITE_COOKIE, "site-1");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

describe("apiFetch", () => {
  it("attaches the access token and the site header, and returns the parsed body", async () => {
    cookieJar.set(ACCESS_TOKEN_COOKIE, "access-123");
    cookieJar.set(LOCALE_COOKIE, "vi");
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "c1" }));

    const result = await apiFetch<{ id: string }>("/contents/c1");

    expect(result).toEqual({ id: "c1" });
    const [, init] = fetchMock.mock.calls[0]!;
    const headers = new Headers(init.headers as HeadersInit);
    expect(headers.get("authorization")).toBe("Bearer access-123");
    expect(headers.get("x-site-id")).toBe("site-1");
    expect(headers.get("accept-language")).toBe("vi");
  });

  it("omits the Authorization header for an anonymous request", async () => {
    cookieJar.set(ACCESS_TOKEN_COOKIE, "access-123");
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

    await apiFetch("/auth/login", { anonymous: true, siteScoped: false });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(new Headers(init.headers as HeadersInit).has("authorization")).toBe(false);
  });

  it("turns a non-2xx into a typed ApiError carrying the status, not a silent undefined", async () => {
    cookieJar.set(ACCESS_TOKEN_COOKIE, "access-123");
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: "boom" }, 500));

    const error = await apiFetch("/contents").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(500);
    expect((error as ApiError).message).toBe("boom");
  });

  it("raises a ForbiddenError for a 403 so the UI can tell it from a crash", async () => {
    cookieJar.set(ACCESS_TOKEN_COOKIE, "access-123");
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: "nope" }, 403));

    await expect(apiFetch("/users")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refreshes once behind a 401 and retries the original request with the new token", async () => {
    cookieJar.set(ACCESS_TOKEN_COOKIE, "stale");
    cookieJar.set(REFRESH_TOKEN_COOKIE, "refresh-1");

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ message: "expired" }, 401)) // first attempt
      .mockResolvedValueOnce(
        jsonResponse({ accessToken: "fresh", refreshToken: "refresh-2" }),
      ) // /auth/refresh
      .mockResolvedValueOnce(jsonResponse({ id: "c1" })); // retry

    const result = await apiFetch<{ id: string }>("/contents/c1");

    expect(result).toEqual({ id: "c1" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // The retry must carry the refreshed token, not the stale one.
    const retryHeaders = new Headers(fetchMock.mock.calls[2]![1].headers as HeadersInit);
    expect(retryHeaders.get("authorization")).toBe("Bearer fresh");
    // ...and the fresh pair is persisted for the next navigation.
    expect(cookieJar.get(ACCESS_TOKEN_COOKIE)).toBe("fresh");
  });

  it("surfaces an expired session as UnauthenticatedError when there is no refresh token", async () => {
    cookieJar.set(ACCESS_TOKEN_COOKIE, "stale");
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: "expired" }, 401));

    await expect(apiFetch("/contents")).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("surfaces UnauthenticatedError when the refresh itself is rejected", async () => {
    cookieJar.set(ACCESS_TOKEN_COOKIE, "stale");
    cookieJar.set(REFRESH_TOKEN_COOKIE, "refresh-1");
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ message: "expired" }, 401))
      .mockResolvedValueOnce(jsonResponse({ message: "no" }, 401)); // refresh fails

    await expect(apiFetch("/contents")).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("propagates a network failure rather than swallowing it into undefined", async () => {
    cookieJar.set(ACCESS_TOKEN_COOKIE, "access-123");
    fetchMock.mockRejectedValueOnce(new TypeError("network down"));

    await expect(apiFetch("/contents")).rejects.toThrow("network down");
  });

  it("returns undefined for a 204 with no body", async () => {
    cookieJar.set(ACCESS_TOKEN_COOKIE, "access-123");
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(apiFetch("/media/x", { method: "DELETE" })).resolves.toBeUndefined();
  });

  it("serialises a JSON body and sets the Content-Type", async () => {
    cookieJar.set(ACCESS_TOKEN_COOKIE, "access-123");
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "c1" }));

    await apiFetch("/contents", { method: "POST", body: { title: "Hi" } });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ title: "Hi" }));
    expect(new Headers(init.headers as HeadersInit).get("content-type")).toBe("application/json");
  });
});
