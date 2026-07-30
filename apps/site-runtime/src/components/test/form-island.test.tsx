import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PublicFormDef } from "@zcmsorg/schemas";
import { FormIsland } from "../form-island";

/**
 * What a visitor is told when something is wrong.
 *
 * The bug these exist for: a quantity of "-2" passed the browser untouched (this
 * component validated no numeric field at all), the server refused it, and the
 * visitor got one banner — "check the fields and try again" — with nothing marking
 * WHICH field or WHY. Every test here is about that message reaching the input it
 * belongs to, in the visitor's language.
 */

const DEF: PublicFormDef = {
  id: "cafe-order",
  title: "Đặt trước",
  submitLabel: "Gửi đơn đặt",
  fields: [
    { name: "customerName", type: "text", required: true, label: "Tên người đặt" },
    { name: "quantity1", type: "number", required: true, min: 1, step: 1, defaultValue: "1", label: "Số lượng" },
    { name: "note", type: "textarea", maxLength: 10, label: "Ghi chú" },
    { name: "item2", type: "text", group: "more", label: "Món thứ hai" },
    { name: "quantity2", type: "number", group: "more", min: 1, defaultValue: "1", label: "Số lượng món hai" },
  ],
  groups: [
    { id: "more", addLabel: "+ Thêm món khác", label: "Món thứ hai", removeLabel: "Bỏ món này" },
  ],
};

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label, { exact: false }), { target: { value } });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FormIsland inline validation", () => {
  it("refuses a negative quantity in the browser, beside the box it was typed in", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<FormIsland def={DEF} locale="vi" />);

    type("Tên người đặt", "Linh");
    type("Số lượng", "-2");
    fireEvent.click(screen.getByRole("button", { name: "Gửi đơn đặt" }));

    // The message names the rule in the visitor's language, and says a VALUE — not
    // "at least 1 characters", which is what a length message would have said.
    expect(await screen.findByText("Vui lòng nhập từ 1 trở lên.")).toBeInTheDocument();
    expect(screen.getByLabelText("Số lượng", { exact: false })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    // And nothing was sent: the round trip that produced the useless banner is gone.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("tells 'not a number' apart from 'out of range'", async () => {
    // Not typed into the box: a native number input refuses letters, which is the
    // point of using one. This code reaches the visitor from the SERVER — a value
    // that arrived by some other route (the no-JS post, an autofill, a paste into
    // a text-typed field) and was refused there.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ ok: false, fields: { quantity1: "number" } }),
      }),
    );
    render(<FormIsland def={DEF} locale="vi" />);

    type("Tên người đặt", "Linh");
    type("Số lượng", "3");
    fireEvent.click(screen.getByRole("button", { name: "Gửi đơn đặt" }));

    expect(await screen.findByText("Vui lòng nhập một con số.")).toBeInTheDocument();
    // Distinct wording from the range message, so the two are never confused.
    expect(screen.queryByText("Vui lòng nhập từ 1 trở lên.")).not.toBeInTheDocument();
  });

  it("clears a field's message as soon as the visitor fixes it", async () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<FormIsland def={DEF} locale="vi" />);

    fireEvent.click(screen.getByRole("button", { name: "Gửi đơn đặt" }));
    // Only the name: the quantity starts at its declared default of 1, which is
    // the point of having one.
    expect(await screen.findByText("Vui lòng nhập trường này.")).toBeInTheDocument();

    type("Tên người đặt", "Linh");
    await waitFor(() =>
      expect(screen.queryByText("Vui lòng nhập trường này.")).not.toBeInTheDocument(),
    );
  });

  it("puts a server-side refusal on the field it names, not in a banner", async () => {
    // A rule only the server ran: the browser is happy, cms-api is not.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ ok: false, fields: { quantity1: "min" } }),
      }),
    );
    render(<FormIsland def={DEF} locale="vi" />);

    type("Tên người đặt", "Linh");
    type("Số lượng", "3");
    fireEvent.click(screen.getByRole("button", { name: "Gửi đơn đặt" }));

    // Worded here, from a code — so a Vietnamese shop never receives an English
    // sentence written by an API.
    expect(await screen.findByText("Vui lòng nhập từ 1 trở lên.")).toBeInTheDocument();
    expect(screen.getByLabelText("Số lượng", { exact: false })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  it("still says something when the server refuses without naming a field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: false }) }),
    );
    render(<FormIsland def={DEF} locale="vi" />);

    type("Tên người đặt", "Linh");
    type("Số lượng", "3");
    fireEvent.click(screen.getByRole("button", { name: "Gửi đơn đặt" }));

    // A plugin's own handled rejection ("already ordered") belongs to no field, so
    // the banner is still the right home for it.
    expect(
      await screen.findByText("Rất tiếc, chưa gửi được. Vui lòng kiểm tra lại các trường và thử lại."),
    ).toBeInTheDocument();
  });

  it("keeps what the visitor typed when a send fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    render(<FormIsland def={DEF} locale="vi" />);

    type("Tên người đặt", "Linh");
    type("Số lượng", "3");
    fireEvent.click(screen.getByRole("button", { name: "Gửi đơn đặt" }));

    await waitFor(() =>
      expect(screen.getByLabelText("Tên người đặt", { exact: false })).toHaveValue("Linh"),
    );
  });

  it("shows the success message and empties the form only on a real success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }),
    );
    render(<FormIsland def={{ ...DEF, successMessage: "Đã nhận đơn." }} locale="vi" />);

    type("Tên người đặt", "Linh");
    type("Số lượng", "3");
    fireEvent.click(screen.getByRole("button", { name: "Gửi đơn đặt" }));

    expect(await screen.findByText("Đã nhận đơn.")).toBeInTheDocument();
  });
});

/**
 * The form a visitor is shown, versus the field list a server validates.
 *
 * The order form declares three items because a shop wants to sell three; someone
 * buying one coffee was being shown all six boxes to do it. Groups are the
 * difference, and they are rendering only — every test here also checks that what
 * is submitted did not change.
 */
describe("FormIsland optional groups", () => {
  it("starts with the group closed, and offers one button to open it", () => {
    render(<FormIsland def={DEF} locale="vi" />);

    expect(screen.queryByLabelText("Món thứ hai", { exact: false })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "+ Thêm món khác" }));
    expect(screen.getByLabelText("Món thứ hai", { exact: false })).toBeInTheDocument();
    // Nothing left to offer, so the button goes.
    expect(screen.queryByRole("button", { name: "+ Thêm món khác" })).not.toBeInTheDocument();
  });

  it("fills a declared default, so a quantity of one is not typed", () => {
    render(<FormIsland def={DEF} locale="vi" />);
    expect(screen.getByLabelText("Số lượng", { exact: false })).toHaveValue(1);
  });

  it("counts in whole drinks and refuses to go below one", () => {
    render(<FormIsland def={DEF} locale="vi" />);
    const quantity = screen.getByLabelText("Số lượng", { exact: false });
    // The spinner itself will not offer 0, 0.5 or -1.
    expect(quantity).toHaveAttribute("min", "1");
    expect(quantity).toHaveAttribute("step", "1");
  });

  it("empties a group that is taken away again", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<FormIsland def={DEF} locale="vi" />);

    type("Tên người đặt", "Linh");
    fireEvent.click(screen.getByRole("button", { name: "+ Thêm món khác" }));
    type("Món thứ hai", "BK-02");
    fireEvent.click(screen.getByRole("button", { name: "Bỏ món này" }));
    fireEvent.click(screen.getByRole("button", { name: "Gửi đơn đặt" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = new URLSearchParams(fetchMock.mock.calls[0]![1].body as string);
    // A box the visitor removed must not still be in the order they are charged for.
    expect(body.get("item2")).toBe("");
    expect(body.get("customerName")).toBe("Linh");
  });

  it("opens a closed group when the server refuses something inside it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ ok: false, fields: { quantity2: "min" } }),
      }),
    );
    render(<FormIsland def={DEF} locale="vi" />);

    type("Tên người đặt", "Linh");
    fireEvent.click(screen.getByRole("button", { name: "Gửi đơn đặt" }));

    // A message on a field nobody can see is not a message.
    expect(await screen.findByLabelText("Số lượng món hai", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("Vui lòng nhập từ 1 trở lên.")).toBeInTheDocument();
  });
});
