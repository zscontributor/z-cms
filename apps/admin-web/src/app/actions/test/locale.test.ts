import { beforeEach, describe, expect, it, vi } from "vitest";
import { LOCALE_COOKIE } from "@/lib/locale";

const { cookieJar, revalidateMock } = vi.hoisted(() => ({
  cookieJar: new Map<string, string>(),
  revalidateMock: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    set: (name: string, value: string) => {
      cookieJar.set(name, value);
    },
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));

import { setLocaleAction } from "../locale";

beforeEach(() => {
  cookieJar.clear();
  revalidateMock.mockClear();
});

describe("setLocaleAction", () => {
  it("stores a supported locale and revalidates the shell", async () => {
    await setLocaleAction("vi");

    expect(cookieJar.get(LOCALE_COOKIE)).toBe("vi");
    // The shell (sidebar, topbar) renders on the server, so the change needs a
    // layout-level revalidate to actually show.
    expect(revalidateMock).toHaveBeenCalledWith("/", "layout");
  });

  it("ignores an unsupported locale rather than storing a value the catalogue cannot serve", async () => {
    // The cookie feeds every subsequent render; letting an arbitrary string in
    // would strand the admin on the key-echo fallback.
    await setLocaleAction("xx-hacker");

    expect(cookieJar.has(LOCALE_COOKIE)).toBe(false);
    expect(revalidateMock).not.toHaveBeenCalled();
  });
});
