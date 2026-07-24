import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge } from "../badge";

describe("Badge", () => {
  it("renders the label it is given", () => {
    render(<Badge>Published</Badge>);
    expect(screen.getByText("Published")).toBeInTheDocument();
  });

  it("carries a pass-through className alongside its tone styling", () => {
    // Callers extend a badge with layout classes; those must survive rather than
    // be dropped by the tone lookup.
    render(<Badge className="ml-2">Draft</Badge>);
    expect(screen.getByText("Draft")).toHaveClass("ml-2");
  });

  it("applies a different class set for a different tone", () => {
    // The tone is the entire reason the component exists — a danger badge and a
    // success badge must not render identically.
    const { container: danger } = render(<Badge tone="danger">Quarantined</Badge>);
    const { container: success } = render(<Badge tone="success">Approved</Badge>);
    const dangerClass = danger.firstElementChild?.getAttribute("class");
    const successClass = success.firstElementChild?.getAttribute("class");
    expect(dangerClass).not.toBe(successClass);
  });
});
