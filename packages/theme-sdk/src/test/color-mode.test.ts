import { describe, expect, it } from "vitest";
import { DEFAULT_COLOR_MODE, resolveColorModes } from "../color-mode";

/**
 * `resolveColorModes` is called twice per request from two different places — once
 * by the runtime, to decide what the bootstrap script does, and once by the theme
 * context, to decide whether a theme may draw a switch. They must never disagree:
 * a visible toggle the runtime has decided to ignore is a button that does nothing,
 * which is the worst of the available outcomes.
 *
 * So the rules live in one function, and these are the rules.
 */
describe("resolveColorModes", () => {
  it("gives a theme that declares nothing both modes and the OS default", () => {
    // The overwhelmingly common case, and the one a theme author should not have to
    // write down. Every theme written before this API existed lands here.
    expect(resolveColorModes({})).toEqual(DEFAULT_COLOR_MODE);
  });

  it("honours a theme that declares both modes and a fixed default", () => {
    const resolved = resolveColorModes({
      colorModes: { supports: ["light", "dark"], default: "dark" },
    });

    expect(resolved.modes).toEqual(["light", "dark"]);
    expect(resolved.default).toBe("dark");
    expect(resolved.toggleable).toBe(true);
  });

  it("makes a single-mode theme un-toggleable and forces its one mode", () => {
    // Aurora is drawn only in the dark. Offering a switch would send the reader to a
    // light page this theme has no colours for.
    const resolved = resolveColorModes({ colorModes: { supports: ["dark"] } });

    expect(resolved.modes).toEqual(["dark"]);
    expect(resolved.toggleable).toBe(false);
    expect(resolved.default).toBe("dark");
  });

  it("ignores a default of 'system' on a single-mode theme", () => {
    // "system" would ask the runtime to choose between one thing and nothing.
    const resolved = resolveColorModes({
      colorModes: { supports: ["light"], default: "system" },
    });

    expect(resolved.default).toBe("light");
    expect(resolved.toggleable).toBe(false);
  });

  it("lets the site owner's setting override the theme's default", () => {
    const resolved = resolveColorModes(
      { colorModes: { supports: ["light", "dark"], default: "light" } },
      { colorMode: "dark" },
    );

    expect(resolved.default).toBe("dark");
  });

  it("refuses an owner setting the theme cannot actually draw", () => {
    // An owner who picks "dark" on a light-only theme is asking for a page that has
    // no dark colours. Honouring it would produce an unreadable site; the request is
    // dropped and the theme's one mode stands.
    const resolved = resolveColorModes(
      { colorModes: { supports: ["light"] } },
      { colorMode: "dark" },
    );

    expect(resolved.default).toBe("light");
    expect(resolved.modes).toEqual(["light"]);
  });

  it("survives a hand-edited manifest", () => {
    // A manifest is data out of a package, not something a compiler checked. Garbage
    // in the array must degrade to the sane default, not crash a render.
    const resolved = resolveColorModes({
      colorModes: {
        supports: ["dark", "dark", "purple" as never],
        default: "chartreuse" as never,
      },
    });

    expect(resolved.modes).toEqual(["dark"]);
    expect(resolved.default).toBe("dark");
    expect(resolved.toggleable).toBe(false);
  });

  it("falls back to both modes when 'supports' is present but empty", () => {
    expect(resolveColorModes({ colorModes: { supports: [] } })).toEqual(
      DEFAULT_COLOR_MODE,
    );
  });

  it("ignores a settings value that is not a mode at all", () => {
    const resolved = resolveColorModes(
      { colorModes: { supports: ["light", "dark"], default: "light" } },
      { colorMode: 42 },
    );

    expect(resolved.default).toBe("light");
  });
});
