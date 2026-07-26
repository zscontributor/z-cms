import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rebuild: vi.fn() }));
vi.mock("@/app/actions/site", () => ({ rebuildSitemapAction: mocks.rebuild }));

import { RebuildSitemapButton } from "../rebuild-sitemap-button";

describe("RebuildSitemapButton", () => {
  beforeEach(() => mocks.rebuild.mockReset());

  it("queues a rebuild for its site and shows the success message", async () => {
    mocks.rebuild.mockResolvedValue({ ok: true, message: "Queued!" });
    const user = userEvent.setup();
    render(<RebuildSitemapButton siteId="site-1" canUpdate={true} />);

    await user.click(screen.getByRole("button"));

    expect(mocks.rebuild).toHaveBeenCalledWith("site-1");
    expect(await screen.findByRole("status")).toHaveTextContent("Queued!");
  });

  it("shows the error message when the rebuild is refused", async () => {
    mocks.rebuild.mockResolvedValue({ ok: false, error: "Not allowed" });
    const user = userEvent.setup();
    render(<RebuildSitemapButton siteId="site-1" canUpdate={true} />);

    await user.click(screen.getByRole("button"));

    expect(await screen.findByRole("status")).toHaveTextContent("Not allowed");
  });

  it("is disabled for someone who cannot update the site", () => {
    render(<RebuildSitemapButton siteId="site-1" canUpdate={false} />);

    expect(screen.getByRole("button")).toBeDisabled();
    expect(mocks.rebuild).not.toHaveBeenCalled();
  });
});
