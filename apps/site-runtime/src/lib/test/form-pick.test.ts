import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formPickScript, readPicks, writePicks } from "../form-pick";

/**
 * The bug this exists for: the cafe theme's menu card said "Thêm", and clicking it
 * scrolled to the pre-order form without adding anything. These tests are about
 * the click actually landing somewhere a form can read it — on the page that has
 * the form and, more importantly, on the page that does not.
 */

function boot(): void {
  // The enhancer is an inline <script>: run it the way the browser would.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(formPickScript())();
}

function addButton(attrs: Record<string, string>): HTMLAnchorElement {
  const el = document.createElement("a");
  el.className = "add";
  el.setAttribute("href", "/#order");
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  document.body.innerHTML = "";
  window.localStorage.clear();
});

afterEach(() => {
  document.body.innerHTML = "";
  window.localStorage.clear();
});

describe("form pick enhancer", () => {
  it("adds the clicked item to the form's basket instead of following the link", () => {
    const badge = document.createElement("b");
    badge.setAttribute("data-zc-pick-count", "cafe-order");
    badge.toggleAttribute("hidden", true);
    document.body.appendChild(badge);
    const button = addButton({ "data-zc-pick": "cafe-order", "data-zc-pick-value": "CF-04" });
    boot();

    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    button.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(readPicks("cafe-order")).toEqual([{ value: "CF-04", qty: 1 }]);
    // The header now says there is one thing in the basket — the whole point of
    // pressing the button, and what was missing before.
    expect(badge.textContent).toBe("1");
    expect(badge.hasAttribute("hidden")).toBe(false);
  });

  it("counts a second press of the same drink rather than listing it twice", () => {
    const button = addButton({ "data-zc-pick": "cafe-order", "data-zc-pick-value": "CF-04" });
    boot();
    button.click();
    button.click();

    expect(readPicks("cafe-order")).toEqual([{ value: "CF-04", qty: 2 }]);
  });

  it("refuses a line the form has no room for, and says so on the button", () => {
    boot();
    const one = addButton({
      "data-zc-pick": "cafe-order",
      "data-zc-pick-value": "CF-01",
      "data-zc-pick-max": "1",
    });
    const two = addButton({
      "data-zc-pick": "cafe-order",
      "data-zc-pick-value": "CF-02",
      "data-zc-pick-max": "1",
    });

    one.click();
    two.click();

    expect(readPicks("cafe-order")).toEqual([{ value: "CF-01", qty: 1 }]);
    expect(two.getAttribute("data-zc-picked")).toBe("full");
    expect(one.getAttribute("data-zc-picked")).toBe("added");
  });

  it("refuses a drink the form cannot take, without touching the basket", () => {
    // The menu is live and the form's options are in a manifest: a drink added at
    // the counter this morning is on the board and not in the form. Counting it
    // and then losing it on the next page is the failure worth avoiding.
    const scope = document.createElement("section");
    scope.setAttribute("data-zc-pick-allow", "CF-01|CF-02");
    document.body.appendChild(scope);
    const button = addButton({ "data-zc-pick": "cafe-order", "data-zc-pick-value": "NEW-9" });
    scope.appendChild(button);
    boot();

    button.click();

    expect(readPicks("cafe-order")).toEqual([]);
    expect(button.getAttribute("data-zc-picked")).toBe("missing");
  });

  it("leaves a row that carried no value as the link it is", () => {
    // A menu row whose column was empty has the attribute REMOVED by the query
    // enhancer. Swallowing that click would strand the visitor on the list.
    const button = addButton({ "data-zc-pick": "cafe-order" });
    boot();

    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    button.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(readPicks("cafe-order")).toEqual([]);
  });

  it("counts a basket filled on another page into the badge on this one", () => {
    writePicks("cafe-order", [
      { value: "CF-01", qty: 2 },
      { value: "TR-01", qty: 1 },
    ]);
    const badge = document.createElement("b");
    badge.setAttribute("data-zc-pick-count", "cafe-order");
    badge.toggleAttribute("hidden", true);
    document.body.appendChild(badge);

    boot();

    expect(badge.textContent).toBe("3");
    expect(badge.hasAttribute("hidden")).toBe(false);
  });

  it("ignores a doctored store rather than pouring it into a form", () => {
    window.localStorage.setItem(
      "zcms.pick.cafe-order",
      JSON.stringify([{ value: "CF-01", qty: -4 }, { value: "" }, 7, { qty: 2 }]),
    );

    expect(readPicks("cafe-order")).toEqual([{ value: "CF-01", qty: 1 }]);
  });
});

/**
 * The drawer half of the contract. The cafe theme's basket button used to scroll
 * to the pre-order form; these are about it opening a drawer over the page instead
 * — one the runtime never renders, only fills in.
 */
describe("form pick drawer", () => {
  function drawer(formId: string, values: string[]): HTMLElement {
    const root = document.createElement("div");
    root.setAttribute("data-zc-pick-drawer", formId);
    root.setAttribute("aria-hidden", "true");
    root.innerHTML =
      `<p data-zc-pick-empty="${formId}">empty</p>` +
      `<ul>${values
        .map(
          (value) =>
            `<li data-zc-pick-line="${formId}" data-zc-pick-value="${value}" hidden>` +
            `<b data-zc-pick-line-qty>1</b>` +
            `<button type="button" data-zc-pick-step="-1">-</button>` +
            `<button type="button" data-zc-pick-step="1">+</button>` +
            `<button type="button" data-zc-pick-drop>x</button>` +
            `</li>`,
        )
        .join("")}</ul>` +
      `<div data-zc-pick-filled="${formId}" hidden>` +
      `<b data-zc-pick-count="${formId}" hidden>0</b>` +
      `<a href="/#order" data-zc-pick-close>order</a>` +
      `</div>` +
      `<button type="button" data-zc-pick-close>close</button>`;
    document.body.appendChild(root);
    return root;
  }

  function opener(formId: string): HTMLAnchorElement {
    const el = document.createElement("a");
    el.setAttribute("href", "/#order");
    el.setAttribute("data-zc-pick-open", formId);
    document.body.appendChild(el);
    return el;
  }

  function line(root: HTMLElement, value: string): HTMLElement {
    return root.querySelector<HTMLElement>(`[data-zc-pick-value="${value}"]`)!;
  }

  it("opens over the page instead of following the link to the form", () => {
    const root = drawer("cafe-order", ["CF-01"]);
    const button = opener("cafe-order");
    boot();

    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    button.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(root.hasAttribute("data-zc-open")).toBe(true);
    expect(root.hasAttribute("aria-hidden")).toBe(false);
  });

  it("stays a link to the form on a page that renders no drawer", () => {
    // The basket button is in the header of every page; the drawer need not be.
    const button = opener("cafe-order");
    boot();

    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    button.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it("shows only the lines the basket holds, with their numbers", () => {
    writePicks("cafe-order", [{ value: "CF-01", qty: 2 }]);
    const root = drawer("cafe-order", ["CF-01", "CF-02"]);
    boot();

    expect(line(root, "CF-01").hasAttribute("hidden")).toBe(false);
    expect(line(root, "CF-01").querySelector("[data-zc-pick-line-qty]")?.textContent).toBe("2");
    expect(line(root, "CF-02").hasAttribute("hidden")).toBe(true);
    // Empty notice out, footer in.
    expect(root.querySelector("[data-zc-pick-empty]")?.hasAttribute("hidden")).toBe(true);
    expect(root.querySelector("[data-zc-pick-filled]")?.hasAttribute("hidden")).toBe(false);
  });

  it("steps a line up and down, and drops it when the last one goes", () => {
    writePicks("cafe-order", [{ value: "CF-01", qty: 1 }]);
    const root = drawer("cafe-order", ["CF-01"]);
    boot();
    const row = line(root, "CF-01");

    row.querySelector<HTMLElement>('[data-zc-pick-step="1"]')!.click();
    expect(readPicks("cafe-order")).toEqual([{ value: "CF-01", qty: 2 }]);

    row.querySelector<HTMLElement>('[data-zc-pick-step="-1"]')!.click();
    row.querySelector<HTMLElement>('[data-zc-pick-step="-1"]')!.click();

    // A line of zero is not a line: it leaves the basket, and the form gets its
    // slot back rather than holding an entry nobody ordered.
    expect(readPicks("cafe-order")).toEqual([]);
    expect(row.hasAttribute("hidden")).toBe(true);
    expect(root.querySelector("[data-zc-pick-empty]")?.hasAttribute("hidden")).toBe(false);
  });

  it("removes a line outright", () => {
    writePicks("cafe-order", [
      { value: "CF-01", qty: 3 },
      { value: "CF-02", qty: 1 },
    ]);
    const root = drawer("cafe-order", ["CF-01", "CF-02"]);
    boot();

    line(root, "CF-01").querySelector<HTMLElement>("[data-zc-pick-drop]")!.click();

    expect(readPicks("cafe-order")).toEqual([{ value: "CF-02", qty: 1 }]);
  });

  it("closes on the ✕ and on Escape, and lets the order link through", () => {
    const root = drawer("cafe-order", ["CF-01"]);
    const button = opener("cafe-order");
    boot();

    button.click();
    const close = [...root.querySelectorAll<HTMLElement>("[data-zc-pick-close]")].find(
      (el) => el.tagName === "BUTTON",
    )!;
    const closeEvent = new MouseEvent("click", { bubbles: true, cancelable: true });
    close.dispatchEvent(closeEvent);
    expect(closeEvent.defaultPrevented).toBe(true);
    expect(root.hasAttribute("data-zc-open")).toBe(false);
    expect(root.getAttribute("aria-hidden")).toBe("true");

    button.click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(root.hasAttribute("data-zc-open")).toBe(false);

    // The link on to the form closes the drawer AND navigates — swallowing it
    // would leave the visitor looking at a shut drawer and nothing else.
    button.click();
    const link = root.querySelector<HTMLElement>("a[data-zc-pick-close]")!;
    const linkEvent = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(linkEvent);
    expect(linkEvent.defaultPrevented).toBe(false);
    expect(root.hasAttribute("data-zc-open")).toBe(false);
  });

  it("empties the drawer when the island empties the basket after an order", () => {
    writePicks("cafe-order", [{ value: "CF-01", qty: 2 }]);
    const root = drawer("cafe-order", ["CF-01"]);
    boot();
    expect(line(root, "CF-01").hasAttribute("hidden")).toBe(false);

    // What FormIsland does on a successful submit.
    writePicks("cafe-order", []);

    expect(line(root, "CF-01").hasAttribute("hidden")).toBe(true);
    expect(root.querySelector("[data-zc-pick-filled]")?.hasAttribute("hidden")).toBe(true);
  });
});
