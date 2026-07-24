import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SubmitButton } from "../submit-button";

describe("SubmitButton", () => {
  it("renders a submit-type button so it drives its enclosing form", () => {
    // It is a submit button by contract — useFormStatus only tracks the form it
    // actually submits.
    render(
      <form>
        <SubmitButton>Save</SubmitButton>
      </form>,
    );
    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toHaveAttribute("type", "submit");
  });

  it("shows its children while the form is idle", () => {
    render(
      <form>
        <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
      </form>,
    );
    // No action is in flight, so the resting label is shown, not the pending one.
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Saving…" })).not.toBeInTheDocument();
  });

  it("stays disabled when the caller disables it", async () => {
    render(
      <form>
        <SubmitButton disabled>Save</SubmitButton>
      </form>,
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});
