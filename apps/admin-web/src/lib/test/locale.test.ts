import { beforeEach, describe, expect, it, vi } from "vitest";

// The cookie store the mocked next/headers reads from; each test seeds it.
const { cookieJar } = vi.hoisted(() => ({ cookieJar: new Map<string, string>() }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
}));

import { getLocale, getT, LOCALE_COOKIE } from "../locale";

beforeEach(() => {
  cookieJar.clear();
});

describe("getLocale", () => {
  it("returns the cookie's locale when it is one the catalogue supports", () => {
    cookieJar.set(LOCALE_COOKIE, "vi");
    return expect(getLocale()).resolves.toBe("vi");
  });

  it("falls back to English when the cookie names an unsupported locale", () => {
    // The cookie is attacker-influenceable and feeds every render; an unknown
    // value must resolve to the base locale, never be trusted through.
    cookieJar.set(LOCALE_COOKIE, "xx-hacker");
    return expect(getLocale()).resolves.toBe("en");
  });

  it("falls back to English when no locale cookie is set", () => {
    return expect(getLocale()).resolves.toBe("en");
  });
});

describe("getT", () => {
  it("returns a translator bound to the resolved locale", async () => {
    cookieJar.set(LOCALE_COOKIE, "en");
    const t = await getT();
    // A real lookup, proving the translator is wired to the catalogue and not a
    // stub that echoes the key.
    expect(t("common.save")).not.toBe("common.save");
  });

  it("returns the key itself for a message that does not exist", () => {
    return getT().then((t) => expect(t("no.such.key.exists")).toBe("no.such.key.exists"));
  });
});
