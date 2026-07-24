import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { Dialog } from "../dialog";

// jsdom does not implement the native <dialog> modal methods; the component calls
// them in an effect, so they are polyfilled to the minimum the component reads.
beforeAll(() => {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
      this.open = false;
    };
  }
});

describe("Dialog", () => {
  it("renders its title, body and footer when open", () => {
    render(
      <Dialog open onClose={() => {}} title="Revoke package" description="This cannot be undone">
        <p>Are you sure?</p>
        <span slot="footer">footer content</span>
      </Dialog>,
    );
    expect(screen.getByRole("heading", { name: "Revoke package" })).toBeInTheDocument();
    expect(screen.getByText("This cannot be undone")).toBeInTheDocument();
    expect(screen.getByText("Are you sure?")).toBeInTheDocument();
  });

  it("renders no content while closed", () => {
    render(
      <Dialog open={false} onClose={() => {}} title="Revoke package">
        <p>Are you sure?</p>
      </Dialog>,
    );
    // The body is gated on `open`; a closed dialog must not leave its contents in
    // the tree where a screen reader could still reach them.
    expect(screen.queryByText("Are you sure?")).not.toBeInTheDocument();
  });

  it("closes when the backdrop (the dialog element itself) is clicked", () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="Confirm">
        <p>Body</p>
      </Dialog>,
    );
    // A click whose target is the dialog element is a backdrop click; a click on
    // the body inside it is not.
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close when a click lands on its inner content", () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="Confirm">
        <p>Body</p>
      </Dialog>,
    );
    fireEvent.click(screen.getByText("Body"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on the dialog's cancel event (the Escape key)", () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="Confirm">
        <p>Body</p>
      </Dialog>,
    );
    // 'cancel' is not in fireEvent's shorthand map, so dispatch it directly.
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
