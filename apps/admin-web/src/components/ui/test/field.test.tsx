import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Checkbox, Field, Input } from "../field";

describe("Field", () => {
  it("associates its label with the control via htmlFor", () => {
    // The accessibility contract: clicking the label focuses the input and a
    // screen reader announces the two together.
    render(
      <Field label="Email" htmlFor="email">
        <Input id="email" />
      </Field>,
    );
    expect(screen.getByLabelText(/Email/)).toBeInstanceOf(HTMLInputElement);
  });

  it("marks a required field with an asterisk in its label", () => {
    render(
      <Field label="Title" htmlFor="title" required>
        <Input id="title" />
      </Field>,
    );
    expect(screen.getByText("*")).toBeInTheDocument();
  });

  it("renders a hint when one is supplied and omits it otherwise", () => {
    const { rerender } = render(
      <Field label="Slug" hint="Lowercase, hyphen-separated">
        <Input />
      </Field>,
    );
    expect(screen.getByText("Lowercase, hyphen-separated")).toBeInTheDocument();

    rerender(
      <Field label="Slug">
        <Input />
      </Field>,
    );
    expect(screen.queryByText("Lowercase, hyphen-separated")).not.toBeInTheDocument();
  });
});

describe("Input", () => {
  it("exposes itself as a textbox and forwards value/placeholder", () => {
    render(<Input placeholder="you@example.com" defaultValue="hi" />);
    const input = screen.getByRole("textbox");
    expect(input).toHaveAttribute("placeholder", "you@example.com");
    expect(input).toHaveValue("hi");
  });
});

describe("Checkbox", () => {
  it("renders an actual checkbox input", () => {
    render(<Checkbox aria-label="Feature this post" />);
    expect(screen.getByRole("checkbox", { name: "Feature this post" })).toBeInTheDocument();
  });
});
