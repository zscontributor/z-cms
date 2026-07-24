import { describe, expect, it } from "vitest";
import { isAbsoluteAssetPath, resolveAssetUrl } from "../asset";

/**
 * The whole point of `asset()` is that a theme names a file without knowing where
 * it was installed, and that a value which ALREADY knows where it lives — an
 * owner's uploaded logo — survives the trip unchanged. Those are the two halves
 * worth pinning down; get the second wrong and every custom favicon on the
 * platform quietly turns into a 404 under some theme's bundle directory.
 */

const BASE = "/theme-assets/vn.zsoft.theme.aurora/1.1.0/";

describe("resolveAssetUrl", () => {
  it("hangs a theme-relative path off the theme's own base", () => {
    expect(resolveAssetUrl(BASE, "assets/logo.png")).toBe(
      "/theme-assets/vn.zsoft.theme.aurora/1.1.0/assets/logo.png",
    );
  });

  it("gives two themes two different URLs for the same file name", () => {
    const aurora = resolveAssetUrl(BASE, "assets/favicon.ico");
    const other = resolveAssetUrl(
      "/theme-assets/vn.zsoft.theme.default/0.1.0/",
      "assets/favicon.ico",
    );

    // This is the property that makes a favicon belong to a theme: neither theme
    // can serve the other's icon, however identically they name it.
    expect(aurora).not.toBe(other);
  });

  it("leaves an uploaded, site-root URL alone", () => {
    // An owner's own favicon. Rewriting this into the theme's bundle would be a
    // 404, and the owner would have no way to explain it.
    expect(resolveAssetUrl(BASE, "/uploads/favicon.ico")).toBe("/uploads/favicon.ico");
  });

  it("leaves an absolute URL alone", () => {
    expect(resolveAssetUrl(BASE, "https://cdn.example.com/logo.png")).toBe(
      "https://cdn.example.com/logo.png",
    );
    expect(resolveAssetUrl(BASE, "//cdn.example.com/logo.png")).toBe(
      "//cdn.example.com/logo.png",
    );
  });

  it("resolves an empty path to nothing, not to the base directory", () => {
    // `ctx.asset(settings.logo || "assets/logo.png")` is the intended shape, but a
    // theme that forgets the fallback must not end up with src="/theme-assets/…/".
    expect(resolveAssetUrl(BASE, "")).toBe("");
    expect(resolveAssetUrl(BASE, "   ")).toBe("");
  });

  it("tolerates a base without a trailing slash, and a './' prefix", () => {
    expect(resolveAssetUrl("/theme-assets/t/1.0.0", "./assets/x.png")).toBe(
      "/theme-assets/t/1.0.0/assets/x.png",
    );
  });
});

describe("isAbsoluteAssetPath", () => {
  it("classifies the forms a setting can arrive in", () => {
    expect(isAbsoluteAssetPath("/uploads/x.png")).toBe(true);
    expect(isAbsoluteAssetPath("https://x.test/a.png")).toBe(true);
    expect(isAbsoluteAssetPath("data:image/png;base64,AAAA")).toBe(true);
    expect(isAbsoluteAssetPath("assets/logo.png")).toBe(false);
  });
});
