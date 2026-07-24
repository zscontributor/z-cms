import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SiteDto } from "@zcmsorg/schemas";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SiteSwitcher } from "../site-switcher";

const { replaceMock, refreshMock, switchSiteMock } = vi.hoisted(() => ({
  replaceMock: vi.fn(),
  refreshMock: vi.fn(),
  switchSiteMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock, refresh: refreshMock }),
}));

vi.mock("@/app/actions/site", () => ({
  switchSiteAction: switchSiteMock,
}));

vi.mock("@/lib/i18n-provider", () => ({
  useT: () => (key: string) => key,
}));

const sites: SiteDto[] = [
  {
    id: "site-1",
    name: "First site",
    slug: "first",
    status: "PUBLISHED",
    domains: [],
    defaultLocale: "vi",
    locales: ["vi"],
    brand: { primaryColor: "#111111", logo: "" },
    activeTheme: null,
  },
  {
    id: "site-2",
    name: "Second site",
    slug: "second",
    status: "PUBLISHED",
    domains: [],
    defaultLocale: "vi",
    locales: ["vi"],
    brand: { primaryColor: "#222222", logo: "" },
    activeTheme: null,
  },
];

describe("SiteSwitcher", () => {
  beforeEach(() => {
    replaceMock.mockClear();
    refreshMock.mockClear();
    switchSiteMock.mockReset();
    switchSiteMock.mockResolvedValue(undefined);
  });

  it("keeps the chosen site selected while switching", async () => {
    const user = userEvent.setup();
    render(<SiteSwitcher sites={sites} currentSiteId="site-1" />);

    const select = screen.getByLabelText("admin.siteSwitcher.label");
    await user.selectOptions(select, "site-2");

    expect(select).toHaveValue("site-2");
    await waitFor(() => expect(switchSiteMock).toHaveBeenCalledWith("site-2"));
    expect(replaceMock).toHaveBeenCalledWith("/");
    expect(refreshMock).toHaveBeenCalled();
  });
});
