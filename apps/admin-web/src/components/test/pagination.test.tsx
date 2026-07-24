import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The pagination is an async server component; its only server dependency is the
// translator, stubbed here to echo keys with the interpolated vars appended so
// the summary line is still assertable without the real catalogue.
vi.mock("@/lib/locale", () => ({
  getT: async () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key} ${JSON.stringify(vars)}` : key,
}));

import { Pagination } from "../pagination";

const BASE = { basePath: "/content/pages", query: { status: "PUBLISHED" } };

/** Render the resolved output of the async component. */
async function renderPagination(props: Parameters<typeof Pagination>[0]) {
  render(await Pagination(props));
}

describe("Pagination", () => {
  it("shows only a results count and no page links when there is a single page", async () => {
    await renderPagination({ page: 1, totalPages: 1, total: 7, ...BASE });
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText(/common.pagination.results/)).toBeInTheDocument();
  });

  it("keeps the page window inside 1..totalPages at the lower edge", async () => {
    // page 1 of 10: the window must start at 1, never at page-2 (which would be
    // -1) — an out-of-range page link is a 404 waiting to be clicked.
    await renderPagination({ page: 1, totalPages: 10, total: 240, ...BASE });
    const nav = screen.getByRole("navigation");
    const numbers = within(nav)
      .getAllByRole("link")
      .map((a) => a.textContent)
      .filter((t) => /^\d+$/.test(t ?? ""));
    expect(numbers).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("keeps the page window inside 1..totalPages at the upper edge", async () => {
    await renderPagination({ page: 10, totalPages: 10, total: 240, ...BASE });
    const numbers = within(screen.getByRole("navigation"))
      .getAllByRole("link")
      .map((a) => a.textContent)
      .filter((t) => /^\d+$/.test(t ?? ""));
    expect(numbers).toEqual(["6", "7", "8", "9", "10"]);
    // No number exceeds the total, and 0 is never offered.
    expect(numbers).not.toContain("0");
    expect(numbers.every((n) => Number(n) <= 10)).toBe(true);
  });

  it("hides the Previous link on the first page and Next on the last", async () => {
    await renderPagination({ page: 1, totalPages: 5, total: 120, ...BASE });
    expect(
      screen.queryByRole("link", { name: "common.pagination.previous" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "common.pagination.next" })).toBeInTheDocument();
  });

  it("preserves the active query params in every page href", async () => {
    // A filtered list must stay filtered when you page through it; dropping the
    // status here would silently widen the result set on page 2.
    await renderPagination({ page: 1, totalPages: 5, total: 120, ...BASE });
    const two = screen.getByRole("link", { name: "2" });
    expect(two).toHaveAttribute("href", expect.stringContaining("status=PUBLISHED"));
    expect(two).toHaveAttribute("href", expect.stringContaining("page=2"));
  });

  it("links page 1 to the bare path without a redundant page=1 param", async () => {
    await renderPagination({ page: 2, totalPages: 5, total: 120, ...BASE });
    const one = screen.getByRole("link", { name: "1" });
    expect(one.getAttribute("href")).not.toContain("page=1");
  });
});
