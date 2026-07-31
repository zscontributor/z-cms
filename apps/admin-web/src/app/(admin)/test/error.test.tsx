import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import AdminError from "../error";

vi.mock("@/lib/i18n-provider", () => ({
  useT: () => (key: string) => key,
}));

/**
 * The admin's error screen, and the one error on it that must NOT offer "Retry".
 *
 * A Server Action is addressed by an id baked into the page at build time, so a
 * tab left open across a deploy asks the running server to run an id it has never
 * heard of. Retrying re-sends the same dead id from the same stale JavaScript —
 * and the action has often already run, which makes a second attempt the worst
 * button on the screen. Only a full load fixes it.
 */
describe("AdminError", () => {
  it("offers a reload, not a retry, when the tab is older than the server", async () => {
    const reset = vi.fn();
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, reload },
    });

    render(
      <AdminError
        error={
          new Error(
            'Server Action "60b7fc22f440074d7db59ddab95b073f82a3f74acc" was not found on the server.',
          )
        }
        reset={reset}
      />,
    );

    expect(screen.getByText("admin.error.staleTitle")).toBeTruthy();
    // Next's own wording names an id and reads like a fault in the software. It is
    // neither, so the reader is told what actually happened instead.
    expect(screen.queryByText(/60b7fc22/)).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "admin.error.reload" }));
    expect(reload).toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
  });

  it("still retries an ordinary failure, and still shows what it was", async () => {
    const reset = vi.fn();
    render(<AdminError error={new Error("Upload failed")} reset={reset} />);

    expect(screen.getByText("admin.error.title")).toBeTruthy();
    expect(screen.getByText("Upload failed")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "common.retry" }));
    expect(reset).toHaveBeenCalled();
  });
});
