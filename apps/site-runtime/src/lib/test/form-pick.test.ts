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
