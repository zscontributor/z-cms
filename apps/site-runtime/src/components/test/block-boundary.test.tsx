import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlockBoundary } from "../block-boundary";

/**
 * The entire point of this component: a block renders arbitrary editor JSON
 * through community theme code, so a throw is a matter of when, not if. When one
 * block explodes, the boundary must catch it and let the REST of the page render.
 * A regression here means one bad block takes down every page it appears on.
 */

/** A block that throws on render, the way a broken theme component would. */
function Boom(): never {
  throw new Error("theme block exploded");
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // React logs caught render errors to console.error; silence it so the failing
  // block's expected throw does not masquerade as a test failure.
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  vi.unstubAllEnvs();
});

describe("BlockBoundary", () => {
  it("renders its children unchanged when nothing throws", () => {
    render(
      <BlockBoundary blockType="core/text">
        <p>healthy block</p>
      </BlockBoundary>,
    );

    expect(screen.getByText("healthy block")).toBeInTheDocument();
  });

  it("catches a throwing block instead of letting it crash the render", () => {
    // Without the boundary this render() call would itself throw and take the
    // whole tree with it.
    expect(() =>
      render(
        <BlockBoundary blockType="community/boom">
          <Boom />
        </BlockBoundary>,
      ),
    ).not.toThrow();
  });

  it("keeps the rest of the page alive when one sibling block throws", () => {
    // The load-bearing behaviour: block twelve throwing must not erase block one.
    render(
      <div>
        <BlockBoundary blockType="core/text">
          <p>surviving sibling</p>
        </BlockBoundary>
        <BlockBoundary blockType="community/boom">
          <Boom />
        </BlockBoundary>
      </div>,
    );

    expect(screen.getByText("surviving sibling")).toBeInTheDocument();
  });

  it("shows a visible diagnostic in development so the author notices the hole", () => {
    vi.stubEnv("NODE_ENV", "development");

    render(
      <BlockBoundary blockType="community/boom">
        <Boom />
      </BlockBoundary>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("community/boom");
    expect(screen.getByRole("alert")).toHaveTextContent("theme block exploded");
  });

  it("renders nothing in production, hiding the broken block from visitors", () => {
    // A visitor must see the other blocks, not a red error card.
    vi.stubEnv("NODE_ENV", "production");

    const { container } = render(
      <BlockBoundary blockType="community/boom">
        <Boom />
      </BlockBoundary>,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
