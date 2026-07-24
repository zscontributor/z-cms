import type { SessionUser, SiteDto } from "@zcmsorg/schemas";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SITE_COOKIE } from "@/lib/cookies";

const { apiFetchMock, canMock, cookieJar, getSessionMock, revalidateMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  canMock: vi.fn(),
  cookieJar: new Map<string, string>(),
  getSessionMock: vi.fn(),
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
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));
vi.mock("@/lib/locale", () => ({
  getT: async () => (key: string) => key,
}));
vi.mock("@/lib/api", () => {
  class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(status: number, message: string, body?: unknown) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.body = body;
    }
  }
  return {
    ApiError,
    apiFetch: apiFetchMock,
    can: canMock,
    getSession: getSessionMock,
    listSites: vi.fn(),
  };
});

import { createSiteAction } from "../site";

const USER = { id: "u1", permissions: ["site:create"] } as unknown as SessionUser;

function site(overrides: Partial<SiteDto> = {}): SiteDto {
  return {
    id: "new-site",
    slug: "shop",
    name: "Shop",
    status: "PUBLISHED",
    defaultLocale: "vi",
    locales: ["vi", "en", "ja"],
    brand: { primaryColor: "#111111", logo: "" },
    domains: [{ id: "d1", hostname: "shop.z-cms.org", isPrimary: true }],
    activeTheme: null,
    ...overrides,
  };
}

beforeEach(() => {
  apiFetchMock.mockReset();
  canMock.mockReset().mockReturnValue(true);
  cookieJar.clear();
  getSessionMock.mockReset().mockResolvedValue(USER);
  revalidateMock.mockClear();
});

describe("createSiteAction", () => {
  it("selects the newly-created site before follow-up site-scoped actions run", async () => {
    cookieJar.set(SITE_COOKIE, "old-site");
    apiFetchMock.mockResolvedValueOnce(site());

    const result = await createSiteAction({
      name: "Shop",
      slug: "shop",
      hostname: "shop.z-cms.org",
      defaultLocale: "vi",
      publish: true,
      brand: { primaryColor: "#111111", logo: "" },
    });

    expect(result.ok).toBe(true);
    expect(apiFetchMock).toHaveBeenCalledWith("/sites", {
      method: "POST",
      body: {
        name: "Shop",
        slug: "shop",
        hostname: "shop.z-cms.org",
        defaultLocale: "vi",
        publish: true,
        brand: { primaryColor: "#111111", logo: "" },
      },
      siteScoped: false,
    });
    expect(cookieJar.get(SITE_COOKIE)).toBe("new-site");
    expect(revalidateMock).toHaveBeenCalledWith("/sites");
    expect(revalidateMock).toHaveBeenCalledWith("/", "layout");
  });
});
