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

/**
 * A page with a scope control — the header's branch picker, filled by its own
 * query — above a list that every branch answers differently.
 */
function scopedPage(): void {
  document.body.innerHTML = `
    <form id="branch-form" data-zc-query="cafe.shop" data-zc-target="#branch" data-zc-initial="">
      <input type="hidden" name="kind" value="branch">
      <select id="branch" data-zc-scope="branch">
        <option value="">All shops</option>
        <template data-zc-query-item><option data-zc-field="label" data-zc-value="code"></option></template>
      </select>
    </form>
    <form id="menu-form" data-zc-query="cafe.shop" data-zc-target="#grid" data-zc-initial="">
      <input type="hidden" name="kind" value="menu">
    </form>
    <div id="grid"><template data-zc-query-item><article data-zc-field="name"></article></template></div>`;
}

/** Answers a query by the `kind` it asked for, and records every URL fetched. */
function answerByKind(byKind: Record<string, Record<string, unknown>[]>): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string) => {
      urls.push(url);
      const kind = new URL(url, "https://shop.test").searchParams.get("kind") ?? "";
      return Promise.resolve({ ok: true, json: async () => ({ items: byKind[kind] ?? [] }) });
    }),
  );
  return urls;
}

const BRANCHES = [
  { code: "CN-Q1", label: "Quận 1" },
  { code: "CN-Q3", label: "Quận 3" },
];

function branchSelect(): HTMLSelectElement {
  return document.querySelector<HTMLSelectElement>("#branch")!;
}

function boot(): void {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(queryScript())();
}

beforeEach(() => {
  document.body.innerHTML = "";
  window.localStorage.clear();
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

  it("fills the row template's own root, not only its children", async () => {
    page(`<article data-zc-field="name" data-zc-attr="data-code:code"></article>`);
    answer([{ code: "CF-04", name: "Cà phê muối" }]);
    boot();

    // The row of a <select> IS an <option>: there is no child to write into.
    await vi.waitFor(() => {
      const el = document.querySelector("[data-zc-query-row]")!;
      expect(el.textContent).toBe("Cà phê muối");
      expect(el.getAttribute("data-code")).toBe("CF-04");
    });
  });
});

/**
 * Scope — the one choice every list on the page is read through.
 *
 * A coffee shop with two branches picks the branch once, in the header, and the
 * menu, the opening hours and the next page all answer for that branch.
 */
describe("plugin-query scope", () => {
  it("turns query rows into real options a select can hold", async () => {
    scopedPage();
    answerByKind({ branch: BRANCHES });
    boot();

    await vi.waitFor(() => {
      expect([...branchSelect().options].map((o) => [o.value, o.text])).toEqual([
        ["", "All shops"],
        ["CN-Q1", "Quận 1"],
        ["CN-Q3", "Quận 3"],
      ]);
    });
  });

  it("does not filter the branch list by the branch", async () => {
    scopedPage();
    const urls = answerByKind({ branch: BRANCHES });
    window.localStorage.setItem("zc-scope:branch", "CN-Q3");
    boot();

    await vi.waitFor(() => expect(urls.length).toBeGreaterThanOrEqual(2));
    const branchUrl = urls.find((url) => url.includes("kind=branch"))!;
    expect(branchUrl).not.toContain("branch=CN-Q3");
  });

  it("sends the stored branch with the first fetch of every other list", async () => {
    scopedPage();
    const urls = answerByKind({ branch: BRANCHES, menu: [{ name: "Cà phê muối" }] });
    // What the visitor chose on the page before. The select is still empty here —
    // its options arrive with the fetch this very boot is about to make — so the
    // stored value, not the DOM, is what the menu must go out asking for.
    window.localStorage.setItem("zc-scope:branch", "CN-Q3");
    boot();

    await vi.waitFor(() => {
      expect(urls.some((url) => url.includes("kind=menu") && url.includes("branch=CN-Q3"))).toBe(
        true,
      );
    });
    // And the picker shows it, once the options it names exist.
    await vi.waitFor(() => expect(branchSelect().value).toBe("CN-Q3"));
  });

  it("re-runs every other list when the branch changes, and remembers it", async () => {
    scopedPage();
    const urls = answerByKind({ branch: BRANCHES, menu: [{ name: "Cà phê muối" }] });
    boot();
    await vi.waitFor(() => expect(branchSelect().options.length).toBe(3));

    branchSelect().value = "CN-Q1";
    branchSelect().dispatchEvent(new Event("change"));

    await vi.waitFor(() => {
      expect(urls.some((url) => url.includes("kind=menu") && url.includes("branch=CN-Q1"))).toBe(
        true,
      );
    });
    expect(window.localStorage.getItem("zc-scope:branch")).toBe("CN-Q1");
    // The branch list itself is refetched by nothing: it holds the control.
    expect(urls.filter((url) => url.includes("kind=branch")).length).toBe(1);
  });

  it("drops a stored branch the shop no longer has, and lists what is left", async () => {
    scopedPage();
    const urls = answerByKind({ branch: BRANCHES, menu: [{ name: "Cà phê muối" }] });
    window.localStorage.setItem("zc-scope:branch", "CN-CLOSED");
    boot();

    await vi.waitFor(() => expect(branchSelect().options.length).toBe(3));
    // The select refused the value, so the value is gone — and the menu asks again
    // without it rather than filtering forever by a shop that closed.
    await vi.waitFor(() => {
      expect(window.localStorage.getItem("zc-scope:branch")).toBe(null);
      const menuUrls = urls.filter((url) => url.includes("kind=menu"));
      expect(menuUrls.length).toBe(2);
      expect(menuUrls[1]).not.toContain("branch=");
    });
  });
});
