import { DEFAULT_COLOR_MODE, type ColorModeContext } from "@zcmsorg/theme-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  COLOR_MODE_ATTRIBUTE,
  COLOR_MODE_STORAGE_KEY,
  COLOR_MODE_TOGGLE_ATTRIBUTE,
  colorModeScript,
} from "@/lib/color-mode";

/**
 * The bootstrap script is a string of JavaScript inlined into the document, which
 * puts it outside everything that normally protects code here: no types, no
 * compiler, no bundler. These tests are the substitute.
 *
 * What they pin is the contract a THEME depends on. A theme renders the SDK's
 * <ColorModeToggle> and styles itself under `html[data-theme="dark"]`, and it has no
 * other way to reach this behaviour. If the attribute names or the delegation drift,
 * every theme on the platform silently loses dark mode — the button stays, and stops
 * doing anything.
 */

const DUAL: ColorModeContext = DEFAULT_COLOR_MODE;

const DARK_ONLY: ColorModeContext = {
  modes: ["dark"],
  default: "dark",
  toggleable: false,
  attribute: COLOR_MODE_ATTRIBUTE,
};

/** Runs the script the way the browser does: as a top-level statement. */
function run(config: ColorModeContext = DUAL): void {
  new Function(colorModeScript(config))();
}

function setPrefersDark(dark: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: dark && query.includes("dark"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

const mode = () => document.documentElement.getAttribute(COLOR_MODE_ATTRIBUTE);

describe("colorModeScript", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute(COLOR_MODE_ATTRIBUTE);
    document.documentElement.style.colorScheme = "";
    document.body.innerHTML = "";
    localStorage.clear();
    setPrefersDark(false);
  });

  it("is a single line, so a stray comment cannot swallow the rest of it", () => {
    // The script is minified by stripping newlines. A `//` comment surviving that
    // would comment out everything after it — silently, and only in production.
    const source = colorModeScript(DUAL);
    expect(source).not.toContain("\n");
    expect(source).not.toMatch(/\/\/[^*]/);
  });

  describe("a theme drawn for both modes", () => {
    it("follows the OS when the visitor has chosen nothing", () => {
      setPrefersDark(true);
      run();

      expect(mode()).toBe("dark");
      expect(document.documentElement.style.colorScheme).toBe("dark");
    });

    it("prefers the visitor's stored choice over the OS", () => {
      // The point of remembering: someone on a dark OS who asked for light gets
      // light, on this site, until they say otherwise.
      localStorage.setItem(COLOR_MODE_STORAGE_KEY, "light");
      setPrefersDark(true);
      run();

      expect(mode()).toBe("light");
    });

    it("starts on the theme's declared default rather than the OS", () => {
      setPrefersDark(false);
      run({ ...DUAL, default: "dark" });

      expect(mode()).toBe("dark");
    });

    it("toggles and persists when the theme's button is clicked", () => {
      document.body.innerHTML = `<button ${COLOR_MODE_TOGGLE_ATTRIBUTE}>x</button>`;
      run();

      const button = document.querySelector("button")!;
      button.click();

      expect(mode()).toBe("dark");
      expect(localStorage.getItem(COLOR_MODE_STORAGE_KEY)).toBe("dark");
      expect(button.getAttribute("aria-pressed")).toBe("true");

      button.click();

      expect(mode()).toBe("light");
      expect(localStorage.getItem(COLOR_MODE_STORAGE_KEY)).toBe("light");
      expect(button.getAttribute("aria-pressed")).toBe("false");
    });

    it("works when the click lands on an icon inside the button", () => {
      // ColorModeToggle renders the glyphs in <span>s, so the event target is almost
      // never the button itself. Delegation has to walk up, or the toggle only works
      // on its 1px border.
      document.body.innerHTML = `<button ${COLOR_MODE_TOGGLE_ATTRIBUTE}><span id="i">☾</span></button>`;
      run();

      document.getElementById("i")!.click();

      expect(mode()).toBe("dark");
    });

    it("drives every toggle on the page, including ones added after it ran", () => {
      // The script is in <head> and runs before the body parses, so it can never hold
      // a reference to a button. Delegation on `document` is what makes that fine —
      // and is why a theme may put the switch anywhere, or twice.
      run();
      document.body.innerHTML =
        `<button id="a" ${COLOR_MODE_TOGGLE_ATTRIBUTE}></button>` +
        `<button id="b" ${COLOR_MODE_TOGGLE_ATTRIBUTE}></button>`;

      document.getElementById("a")!.click();

      expect(mode()).toBe("dark");
      expect(document.getElementById("b")!.getAttribute("aria-pressed")).toBe("true");
    });
  });

  describe("a theme drawn for a single mode", () => {
    // The click case cannot be tested here: a `document` listener installed by an
    // earlier test in this file outlives it, so a dual-mode listener would answer
    // the click and the assertion would be measuring the wrong script. Vitest
    // isolates per FILE, so it lives in color-mode-forced.test.ts, where nothing
    // else has ever installed one.

    it("forces its one mode, whatever the OS prefers", () => {
      // Aurora has no light palette. A reader whose OS is light must still get the
      // theme as it was drawn, not a half-painted page.
      setPrefersDark(false);
      run(DARK_ONLY);

      expect(mode()).toBe("dark");
    });

    it("ignores a stored preference from some other site's theme", () => {
      localStorage.setItem(COLOR_MODE_STORAGE_KEY, "light");
      run(DARK_ONLY);

      expect(mode()).toBe("dark");
    });
  });

  it("still renders the page when localStorage throws", () => {
    // Safari in a private window, and any sandboxed iframe. A site that failed to
    // render because it could not remember a colour has its priorities backwards.
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    document.body.innerHTML = `<button ${COLOR_MODE_TOGGLE_ATTRIBUTE}></button>`;

    expect(() => run()).not.toThrow();
    expect(mode()).toBe("light");

    expect(() => document.querySelector("button")!.click()).not.toThrow();
    expect(mode()).toBe("dark");

    vi.restoreAllMocks();
  });
});
