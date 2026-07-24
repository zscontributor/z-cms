import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock("@/app/actions/zai", () => ({ zaiAdminChatAction: mocks.chat }));
import { ZaiAdmin } from "../zai-admin";

describe("ZaiAdmin", () => {
  beforeEach(() => mocks.chat.mockReset());
  it("sends normal commands without destructive confirmation", async () => {
    mocks.chat.mockResolvedValue({ ok: true, answer: "Done" });
    const user = userEvent.setup(); render(<ZaiAdmin />);
    await user.type(screen.getByPlaceholderText(/Tạo một blog draft/i), "Tạo page");
    await user.click(screen.getByRole("button", { name: "Gửi" }));
    expect(mocks.chat).toHaveBeenCalledWith(expect.arrayContaining([{ role: "user", content: "Tạo page" }]), false);
  });
  it("sends confirmDestructive only after the explicit delete confirmation", async () => {
    mocks.chat.mockResolvedValueOnce({ ok: true, answer: "Confirm?", confirmationRequired: true })
      .mockResolvedValueOnce({ ok: true, answer: "Deleted" });
    const user = userEvent.setup(); render(<ZaiAdmin />);
    await user.type(screen.getByPlaceholderText(/Tạo một blog draft/i), "Xóa page");
    await user.click(screen.getByRole("button", { name: "Gửi" }));
    await user.click(await screen.findByRole("button", { name: "Xác nhận xóa" }));
    expect(mocks.chat).toHaveBeenLastCalledWith(expect.arrayContaining([{ role: "user", content: "Xóa page" }]), true);
  });
});
