import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE, SITE_COOKIE } from "@/lib/cookies";

// A cookie store the action writes into, plus spies to assert what it did.
const { cookieJar, redirectMock, revalidateMock } = vi.hoisted(() => ({
  cookieJar: new Map<string, string>(),
  redirectMock: vi.fn(),
  revalidateMock: vi.fn(),
}));

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
vi.mock("next/navigation", () => ({ redirect: redirectMock }));
vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));

import { loginAction } from "../auth";

/** Build the FormData the login form posts. */
function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  cookieJar.clear();
  redirectMock.mockClear();
  revalidateMock.mockClear();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

/** The API's happy-path answer to POST /auth/login. */
function loginOk() {
  return new Response(JSON.stringify({ accessToken: "at", refreshToken: "rt", user: {} }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("loginAction", () => {
  it("rejects an invalid email before it ever contacts the API", async () => {
    // A server action is a public endpoint; validating first means a malformed
    // request never reaches the auth service at all.
    const state = await loginAction({}, form({ email: "not-an-email", password: "x".repeat(12) }));

    expect(state.fieldErrors?.email).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports invalid credentials without setting a session cookie", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 401 }));

    const state = await loginAction({}, form({ email: "a@b.co", password: "password1234" }));

    expect(state.error).toBeTruthy();
    expect(cookieJar.has(ACCESS_TOKEN_COOKIE)).toBe(false);
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("surfaces an unreachable API as an error state instead of throwing into the UI", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("connection refused"));

    const state = await loginAction({}, form({ email: "a@b.co", password: "password1234" }));

    expect(state.error).toBeTruthy();
  });

  it("stores the tokens, clears the stale site, and redirects on success", async () => {
    cookieJar.set(SITE_COOKIE, "old-site");
    fetchMock.mockResolvedValueOnce(loginOk());

    await loginAction({}, form({ email: "a@b.co", password: "password1234", next: "/content" }));

    expect(cookieJar.get(ACCESS_TOKEN_COOKIE)).toBe("at");
    expect(cookieJar.get(REFRESH_TOKEN_COOKIE)).toBe("rt");
    // A fresh login must not inherit the previous account's selected site.
    expect(cookieJar.has(SITE_COOKIE)).toBe(false);
    expect(redirectMock).toHaveBeenCalledWith("/content");
  });

  it("refuses an off-origin redirect target crafted through ?next", async () => {
    // THE ATTACK: a phishing link ?next=https://evil.com would, if trusted, bounce
    // a freshly authenticated user off-site. Only a same-origin relative path is
    // an acceptable destination.
    fetchMock.mockResolvedValueOnce(loginOk());

    await loginAction(
      {},
      form({ email: "a@b.co", password: "password1234", next: "https://evil.com" }),
    );

    expect(redirectMock).toHaveBeenCalledWith("/");
    expect(redirectMock).not.toHaveBeenCalledWith("https://evil.com");
  });

  it("refuses a protocol-relative //evil.com redirect target", async () => {
    // `//evil.com` is off-origin to a browser but starts with a slash; the guard
    // must reject it too, not just `https://`.
    fetchMock.mockResolvedValueOnce(loginOk());

    await loginAction(
      {},
      form({ email: "a@b.co", password: "password1234", next: "//evil.com" }),
    );

    expect(redirectMock).toHaveBeenCalledWith("/");
  });

  it("allows a same-origin relative next through unchanged", async () => {
    fetchMock.mockResolvedValueOnce(loginOk());

    await loginAction(
      {},
      form({ email: "a@b.co", password: "password1234", next: "/media?folder=root" }),
    );

    expect(redirectMock).toHaveBeenCalledWith("/media?folder=root");
  });
});
