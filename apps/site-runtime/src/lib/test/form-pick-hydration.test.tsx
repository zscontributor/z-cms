import { renderToStaticMarkup } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formPickScript } from "../form-pick";

/**
 * The bug this exists for, found on coffee.z-cms.org and reproduced with a clean
 * profile on EVERY page: `Minified React error #418` — hydration failed, tree
 * regenerated on the client.
 *
 * The enhancer is an inline `<script>` in the body, so it runs while the HTML is
 * still being parsed — long before React's chunk has even downloaded. Its `boot()`
 * writes the basket into the theme's markup, and React then hydrates markup that
 * no longer matches what the server sent. The badge alone was enough: the server
 * renders `<b data-zc-pick-count hidden></b>` with no children, `boot()` puts the
 * text "0" inside it, and a text node React did not render is a hydration failure.
 *
 * The runtime cannot fix this by painting later — there is no signal for "React has
 * hydrated", and a `setTimeout` would just be a race with the network. The fix is
 * the one React documents for exactly this case: the theme marks the elements the
 * runtime writes into with `suppressHydrationWarning`, and React stops comparing
 * them. These tests hold that line — the first fails against the old markup, and
 * both are here so a theme dropping the prop is caught by a test rather than by a
 * blank page in production.
 *
 * `hydrateRoot`'s `onRecoverableError` is what #418 arrives as in a production
 * build, which is why it is the assertion rather than a console spy.
 */

/** The runtime's enhancer, run the way the browser runs it: during parse. */
function boot(): void {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(formPickScript())();
}

/** A theme's header badge and one drawer line, before and after the fix. */
function Markup({ suppress }: { suppress: boolean }) {
  return (
    <div className="theme">
      <a href="/#order" data-zc-pick-open="cafe-order">
        <span>Basket</span>
        <b data-zc-pick-count="cafe-order" hidden suppressHydrationWarning={suppress}>
          0
        </b>
      </a>
      <div data-zc-pick-drawer="cafe-order" aria-hidden="true">
        <p data-zc-pick-empty="cafe-order" suppressHydrationWarning={suppress}>
          Your basket is empty.
        </p>
        <ul>
          <li
            data-zc-pick-line="cafe-order"
            data-zc-pick-value="CF-01"
            hidden
            suppressHydrationWarning={suppress}
          >
            <span>Cà phê sữa đá</span>
            <b data-zc-pick-line-qty suppressHydrationWarning={suppress}>
              1
            </b>
          </li>
        </ul>
        <div data-zc-pick-filled="cafe-order" hidden suppressHydrationWarning={suppress} />
      </div>
    </div>
  );
}

/**
 * Server-render, let the enhancer loose on the HTML, then hydrate — the exact
 * order the browser does it in.
 */
async function hydrateAfterBoot(suppress: boolean): Promise<unknown[]> {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(<Markup suppress={suppress} />);
  document.body.appendChild(container);

  boot();

  const errors: unknown[] = [];
  await act(async () => {
    hydrateRoot(container, <Markup suppress={suppress} />, {
      onRecoverableError: (error) => errors.push(error),
    });
  });
  return errors;
}

beforeEach(() => {
  document.body.innerHTML = "";
  window.localStorage.clear();
});

afterEach(() => {
  document.body.innerHTML = "";
  window.localStorage.clear();
});

describe("form pick enhancer and hydration", () => {
  it("does not break hydration with an empty basket", async () => {
    // The failing case in production: nothing in the basket, and the badge still
    // gets a "0" written into an element the server rendered empty.
    expect(await hydrateAfterBoot(true)).toEqual([]);
  });

  it("does not break hydration with a basket filled on an earlier page", async () => {
    window.localStorage.setItem(
      "zcms.pick.cafe-order",
      JSON.stringify([{ value: "CF-01", qty: 3 }]),
    );

    expect(await hydrateAfterBoot(true)).toEqual([]);
  });

  it("would break hydration without the opt-out — which is why the theme sets it", async () => {
    window.localStorage.setItem(
      "zcms.pick.cafe-order",
      JSON.stringify([{ value: "CF-01", qty: 3 }]),
    );

    expect((await hydrateAfterBoot(false)).length).toBeGreaterThan(0);
  });
});
