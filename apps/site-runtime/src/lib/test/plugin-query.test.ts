import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryScript } from "../plugin-query";

/**
 * `data-zc-attr` — how a row's identity reaches a control that acts on it later.
 *
 * A menu card's Add button has to know WHICH drink it adds, and the drink is a
 * value the plugin answered with, not something the theme could render. Values are
 * still text and the fence is by attribute NAME: `data-*` only, so plugin data can
 * never become a handler or a URL.
 */

function page(rowHtml: string): void {
  document.body.innerHTML = `
    <form data-zc-query="cafe.shop" data-zc-target="#grid" data-zc-initial="">
      <input type="hidden" name="kind" value="menu">
    </form>
    <div id="grid">
      <template data-zc-query-item>${rowHtml}</template>
      <p data-zc-query-empty hidden></p>
      <p data-zc-query-error hidden></p>
    </div>`;
}

function answer(items: Record<string, unknown>[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items }) }),
  );
}

function boot(): void {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(queryScript())();
}

beforeEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("plugin-query row attributes", () => {
  it("writes row values into the row's own data-* attributes", async () => {
    page(`<article><a class="add" data-zc-pick="cafe-order" data-zc-attr="data-zc-pick-value:code"></a></article>`);
    answer([{ code: "CF-04", name: "Cà phê muối", price: 1500 }]);
    boot();

    await vi.waitFor(() => {
      expect(document.querySelector(".add")?.getAttribute("data-zc-pick-value")).toBe("CF-04");
    });
  });

  it("writes a number raw, so the value still matches itself", async () => {
    page(`<article><b data-zc-attr="data-price:price"></b></article>`);
    answer([{ code: "CF-04", price: 1500 }]);
    boot();

    // A thousands separator here would make "1500" stop being "1500". Only the
    // TEXT of a row is formatted for reading.
    await vi.waitFor(() => {
      expect(document.querySelector("b")?.getAttribute("data-price")).toBe("1500");
    });
  });

  it("refuses to write anything that is not a data-* attribute", async () => {
    page(`<article><a data-zc-attr="onclick:code,href:code,data-ok:code"></a></article>`);
    answer([{ code: "javascript:alert(1)" }]);
    boot();

    await vi.waitFor(() => {
      const el = document.querySelector("a")!;
      expect(el.getAttribute("data-ok")).toBe("javascript:alert(1)");
      expect(el.hasAttribute("onclick")).toBe(false);
      expect(el.hasAttribute("href")).toBe(false);
    });
  });

  it("removes the attribute for a row whose column is empty", async () => {
    page(`<article><a data-zc-pick-value="stale" data-zc-attr="data-zc-pick-value:code"></a></article>`);
    answer([{ code: "" }]);
    boot();

    await vi.waitFor(() => {
      expect(document.querySelector("a")?.hasAttribute("data-zc-pick-value")).toBe(false);
    });
  });
});
