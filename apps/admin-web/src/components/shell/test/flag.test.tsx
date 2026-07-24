import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Flag } from "../flag";

/**
 * The contract this component exists to keep is not "shows a flag" — it is
 * "never breaks the row it sits in". A language with no flag, an unknown locale,
 * an override that says *no flag*: all of them have to leave a switcher that is
 * still readable and still the same shape. So most of what is tested here is the
 * absence case, which is the one that ships broken if nobody looks at it.
 */
describe("Flag", () => {
  beforeEach(() => {
    vi.stubEnv("ADMIN_BASE_PATH", "/admin");
  });

  it("renders the flag of the country a locale resolves to", () => {
    const { container } = render(<Flag locale="vi" />);
    const img = container.querySelector("img");

    expect(img).toHaveAttribute("src", "/admin/z-flags/vn.svg");
  });

  it("reads the region off a tag that carries one", () => {
    const { container } = render(<Flag locale="pt-BR" />);

    expect(container.querySelector("img")).toHaveAttribute("src", "/admin/z-flags/br.svg");
  });

  it("prefers a flag the caller already resolved over deriving its own", () => {
    // A LocaleInfo from the registry carries `flag`, and it may be an override
    // the contributor wrote. Deriving here anyway would silently ignore it.
    const { container } = render(<Flag locale="en" flag="us" />);

    expect(container.querySelector("img")).toHaveAttribute("src", "/admin/z-flags/us.svg");
  });

  describe("when the language has no flag", () => {
    it("falls back to the locale code instead of a broken image", () => {
      // Arabic is spoken across twenty countries; `flagFor` returns null for it
      // on purpose. Rendering an <img src="null"> here would be a broken-image
      // icon in every Arabic switcher.
      const { container } = render(<Flag locale="ar" />);

      expect(container.querySelector("img")).toBeNull();
      expect(screen.getByText("ar")).toBeInTheDocument();
    });

    it("honours an explicit null override, even for a language that has one", () => {
      const { container } = render(<Flag locale="en" flag={null} />);

      expect(container.querySelector("img")).toBeNull();
      expect(screen.getByText("en")).toBeInTheDocument();
    });

    it("falls back for a locale nothing has ever heard of", () => {
      // A site's locales are free text in the database. This is the one that
      // reaches production without anyone having typed it into locales.json.
      const { container } = render(<Flag locale="xx" />);

      expect(container.querySelector("img")).toBeNull();
      expect(screen.getByText("xx")).toBeInTheDocument();
    });

    it("keeps the slot the same size, so the row does not reflow", () => {
      // The whole reason the fallback is a sized box and not `null`: a switcher
      // with one flagless language must not have one row indented differently
      // from its neighbours.
      const { container: withFlag } = render(<Flag locale="vi" />);
      const { container: without } = render(<Flag locale="ar" />);

      const flagged = withFlag.firstElementChild?.getAttribute("class") ?? "";
      const bare = without.firstElementChild?.getAttribute("class") ?? "";

      for (const size of ["h-[15px]", "w-5", "shrink-0"]) {
        expect(flagged).toContain(size);
        expect(bare).toContain(size);
      }
    });

    it("shows at most two characters, so a long tag cannot overflow the box", () => {
      render(<Flag locale="es-419" />);

      expect(screen.getByText("es")).toBeInTheDocument();
      expect(screen.queryByText("es-419")).toBeNull();
    });
  });

  describe("accessibility", () => {
    it("hides the flag from assistive tech — the native name is the label", () => {
      // A screen reader that reads "flag of Vietnam, Tiếng Việt" is reading the
      // decoration twice. The name does the naming; the flag is an anchor for
      // the eye.
      const { container } = render(<Flag locale="vi" />);
      const img = container.querySelector("img");

      expect(img).toHaveAttribute("aria-hidden", "true");
      expect(img).toHaveAttribute("alt", "");
    });

    it("hides the code fallback too — it is not a second label", () => {
      const { container } = render(<Flag locale="ar" />);

      expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
    });
  });

  it("carries a pass-through className alongside its own sizing", () => {
    const { container } = render(<Flag locale="vi" className="mr-2" />);

    expect(container.querySelector("img")).toHaveClass("mr-2");
  });
});
