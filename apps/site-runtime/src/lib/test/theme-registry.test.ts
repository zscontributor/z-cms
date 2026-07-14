import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The registry is the thin, never-throwing front door to theme resolution: a
 * site rendering the wrong theme deserves an alert, but a site returning 500 to
 * every visitor is an outage. So the contract is that resolveTheme always yields
 * *a* theme — the requested one, or the default flagged `degraded` — and never
 * rejects. The untrusted loading itself lives in theme-loader and is mocked here.
 */

const loadTheme = vi.fn();
vi.mock("../theme-loader", () => ({
  loadTheme: (...args: unknown[]) => loadTheme(...args),
  // Not stubbed: where a built-in theme's assets are served from is a fact about
  // the runtime, not a collaborator worth faking, and a fake would let the registry
  // hand out an asset base that does not exist.
  builtInAssetBase: (key: string) => `/z-theme-assets/${encodeURIComponent(key)}/`,
}));

import defaultTheme from "@zcmsorg/theme-default";
import {
  DEFAULT_THEME_KEY,
  getDefaultTheme,
  listBuiltInThemeKeys,
  platformIcons,
  resolveTheme,
  withPlatformIcons,
} from "../theme-registry";

beforeEach(() => {
  loadTheme.mockReset();
  loadTheme.mockResolvedValue({ theme: { marker: "loaded" }, stylesheet: null, degraded: false });
});

describe("resolveTheme", () => {
  it("returns the default theme, flagged degraded, when no key is given", async () => {
    // A site with no active theme must still render — with the default, and an
    // honest degraded flag so the operator knows.
    const result = await resolveTheme(null, null);

    expect(result.theme).toBe(defaultTheme);
    expect(result.degraded).toBe(true);
    expect(loadTheme).not.toHaveBeenCalled();
  });

  it("delegates a real key to the loader", async () => {
    const result = await resolveTheme("vn.zsoft.theme.corp", "1.2.3");

    expect(loadTheme).toHaveBeenCalledWith("vn.zsoft.theme.corp", "1.2.3", undefined);
    expect(result.theme).toEqual({ marker: "loaded" });
  });

  it("defaults a missing version to 0.0.0 rather than passing undefined to the loader", async () => {
    await resolveTheme("vn.zsoft.theme.corp", null);

    expect(loadTheme).toHaveBeenCalledWith("vn.zsoft.theme.corp", "0.0.0", undefined);
  });

  it("threads the origin through so the loader can pick the right trust route", async () => {
    await resolveTheme("vn.zsoft.theme.corp", "1.2.3", "SIDELOAD");

    expect(loadTheme).toHaveBeenCalledWith("vn.zsoft.theme.corp", "1.2.3", "SIDELOAD");
  });
});

describe("getDefaultTheme", () => {
  it("returns the compiled-in fallback theme", () => {
    expect(getDefaultTheme()).toBe(defaultTheme);
  });
});

describe("DEFAULT_THEME_KEY", () => {
  it("is the default theme's own manifest id", () => {
    expect(DEFAULT_THEME_KEY).toBe(defaultTheme.manifest.id);
  });
});

describe("listBuiltInThemeKeys", () => {
  it("lists exactly the default theme, the only one compiled in", () => {
    expect(listBuiltInThemeKeys()).toEqual([DEFAULT_THEME_KEY]);
  });
});

describe("platformIcons", () => {
  it("resolves the default theme's own icons against the built-in asset base", () => {
    // Not a restated list of paths: whatever the default theme's manifest says its
    // icons are, that is what the platform falls back to.
    const icons = platformIcons();
    const shipped = defaultTheme.manifest.seo?.icons ?? {};

    expect(shipped.favicon).toBeTruthy();
    expect(icons.favicon).toBe(
      `/z-theme-assets/${DEFAULT_THEME_KEY}/${shipped.favicon}`,
    );
    expect(icons.icon).toBe(`/z-theme-assets/${DEFAULT_THEME_KEY}/${shipped.icon}`);
  });

  it("carries themeColor through as a colour, not as a path", () => {
    expect(platformIcons().themeColor).toBe("#FA5600");
  });
});

describe("withPlatformIcons", () => {
  it("gives a theme that ships no icons the platform's, so no site has a blank tab", () => {
    // Aurora, and any third-party theme that never thought about a favicon. Before
    // this, such a site emitted no <link rel=icon> at all and the browser fell back
    // to a 404 on /favicon.ico.
    const icons = withPlatformIcons({});

    expect(icons.favicon).toContain("/z-theme-assets/");
    expect(icons.icon).toContain("/z-theme-assets/");
    expect(icons.appleTouchIcon).toContain("/z-theme-assets/");
  });

  it("never overrides an icon the theme did declare", () => {
    // The load-bearing one: a theme WITH a favicon must keep it. If the fallback
    // won here, every branded site on the platform would silently show Z-CMS's
    // mark in the browser tab.
    const icons = withPlatformIcons({ favicon: "/theme-assets/aurora/1.1.0/fav.ico" });

    expect(icons.favicon).toBe("/theme-assets/aurora/1.1.0/fav.ico");
  });

  it("fills in field by field, so a partial set keeps what it has", () => {
    // A theme with a favicon but no apple-touch icon keeps its favicon and borrows
    // only the one it lacks.
    const icons = withPlatformIcons({ favicon: "/uploads/owner.ico" });

    expect(icons.favicon).toBe("/uploads/owner.ico");
    expect(icons.appleTouchIcon).toContain("/z-theme-assets/");
  });

  it("keeps a site owner's uploaded favicon, which resolveSeo has already folded in", () => {
    const icons = withPlatformIcons({ favicon: "https://cdn.test/brand.ico" });

    expect(icons.favicon).toBe("https://cdn.test/brand.ico");
  });
});
