import type { ColorModeContext } from "@zcmsorg/theme-sdk";
import { describe, expect, it } from "vitest";
import {
  COLOR_MODE_ATTRIBUTE,
  COLOR_MODE_STORAGE_KEY,
  COLOR_MODE_TOGGLE_ATTRIBUTE,
  colorModeScript,
} from "@/lib/color-mode";

/**
 * A file of its own, containing one test, for a reason worth writing down.
 *
 * The bootstrap script registers a listener on `document`, and a listener on
 * `document` outlives the test that installed it — jsdom hands every test in a file
 * the same document. So in color-mode.test.ts, where dual-mode scripts have already
 * run, a click is answered by *those* listeners too, and a test of "the forced-mode
 * script ignores clicks" would really be testing a page with four scripts on it.
 *
 * Vitest isolates per file. Here, nothing has ever installed a listener, so the click
 * below reaches exactly one script: the one under test.
 */

const DARK_ONLY: ColorModeContext = {
  modes: ["dark"],
  default: "dark",
  toggleable: false,
  attribute: COLOR_MODE_ATTRIBUTE,
};

describe("colorModeScript, for a single-mode theme", () => {
  it("does not toggle, even if a toggle somehow reaches the page", () => {
    // The SDK's ColorModeToggle renders nothing on such a theme, so this ought to be
    // unreachable. But a hand-rolled button in a third-party theme is not, and it must
    // not be able to flip the site into a mode the theme has no colours for.
    document.body.innerHTML = `<button ${COLOR_MODE_TOGGLE_ATTRIBUTE}></button>`;
    new Function(colorModeScript(DARK_ONLY))();

    expect(document.documentElement.getAttribute(COLOR_MODE_ATTRIBUTE)).toBe("dark");

    document.querySelector("button")!.click();

    expect(document.documentElement.getAttribute(COLOR_MODE_ATTRIBUTE)).toBe("dark");
    expect(localStorage.getItem(COLOR_MODE_STORAGE_KEY)).toBeNull();
  });
});
