import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button, LinkButton, buttonClasses } from "../button";

describe("Button", () => {
  it("renders a real button with its accessible name", () => {
    render(<Button>Save changes</Button>);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeInTheDocument();
  });

  it("defaults to type=button so it never submits a surrounding form by accident", () => {
    // An <button> with no type is a submit button; a toolbar button that quietly
    // submits the page's form is a classic footgun this default closes.
    render(<Button>Go</Button>);
    expect(screen.getByRole("button", { name: "Go" })).toHaveAttribute("type", "button");
  });

  it("calls its click handler when pressed", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Publish</Button>);

    await userEvent.click(screen.getByRole("button", { name: "Publish" }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not fire its handler while disabled", async () => {
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} disabled>
        Publish
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Publish" });
    expect(button).toBeDisabled();
    await userEvent.click(button);

    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("LinkButton", () => {
  it("renders navigation as a real link carrying its href", () => {
    // Navigation must stay a link — right-click-open, middle-click, and screen
    // readers all depend on it being an <a>, not a button with an onClick.
    render(<LinkButton href="/content/pages">Pages</LinkButton>);
    const link = screen.getByRole("link", { name: "Pages" });
    expect(link).toHaveAttribute("href", "/content/pages");
  });
});

describe("buttonClasses", () => {
  it("always includes the disabled-state affordances", () => {
    // Every variant shares the disabled treatment; asserting it here guards the
    // shared base string rather than any one colour.
    expect(buttonClasses("primary")).toContain("disabled:opacity-50");
  });
});
