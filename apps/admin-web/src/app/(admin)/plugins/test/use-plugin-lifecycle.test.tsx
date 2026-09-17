import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPluginDto } from "@/lib/api";
import { usePluginLifecycle } from "../use-plugin-lifecycle";

const { installMock, activateMock, deactivateMock, refreshMock } = vi.hoisted(() => ({
  installMock: vi.fn(),
  activateMock: vi.fn(),
  deactivateMock: vi.fn(),
  refreshMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

vi.mock("@/app/actions/plugin", () => ({
  installPluginAction: installMock,
  activatePluginAction: activateMock,
  deactivatePluginAction: deactivateMock,
  uninstallPluginAction: vi.fn(),
  savePluginSettingsAction: vi.fn(),
}));

vi.mock("@/lib/i18n-provider", () => ({
  useT: () => (key: string) => key,
}));

beforeAll(() => {
  // jsdom has no native <dialog> modal methods; the consent dialog calls them.
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
      this.open = false;
    };
  }
});

function plugin(over: Partial<CatalogPluginDto> = {}): CatalogPluginDto {
  return {
    key: "vn.zsoft.plugin.cafe",
    name: "Cafe Manager",
    description: "",
    publisher: "Z-SOFT",
    version: "0.4.0",
    installed: false,
    status: null,
    permissions: ["data:own"],
    grantedPermissions: null,
    networkHosts: [],
    settingsSchema: null,
    settings: null,
    orgActive: false,
    ...over,
  } as unknown as CatalogPluginDto;
}

/** The card, reduced to the two things this is about: the button and the dialogs. */
function Harness({ dto }: { dto: CatalogPluginDto }) {
  const life = usePluginLifecycle(dto, "site", true);
  return (
    <div>
      <button type="button" onClick={life.openConsent}>
        install
      </button>
      <button type="button" onClick={life.toggleActivation}>
        toggle
      </button>
      <span data-testid="pending">{life.pending ? "busy" : "idle"}</span>
      {life.dialogs}
    </div>
  );
}

beforeEach(() => {
  installMock.mockReset().mockResolvedValue({ ok: true, message: "installed" });
  activateMock.mockReset().mockResolvedValue({ ok: true, message: "activated" });
  deactivateMock.mockReset().mockResolvedValue({ ok: true, message: "deactivated" });
  refreshMock.mockReset();
});

/**
 * Installing a plugin is not one request, and the screen used to admit only the
 * first of them: the install returned, the dialog closed, and `setup()` was still
 * creating the plugin's tables. The menu those tables are behind is drawn by the
 * admin LAYOUT, above this page, so it arrived only on the next full page load.
 */
describe("usePluginLifecycle", () => {
  it("activates after consent and refreshes the shell so the plugin's menu appears", async () => {
    render(<Harness dto={plugin()} />);

    await userEvent.click(screen.getByRole("button", { name: "install" }));
    await userEvent.click(screen.getByRole("button", { name: "plugins.consent.confirmInstall" }));

    await waitFor(() => expect(activateMock).toHaveBeenCalledWith("vn.zsoft.plugin.cafe", "site"));
    // Not `revalidatePath` — that is the page. The sidebar is the layout above it,
    // and only a router refresh re-renders that.
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
  });

  it("keeps the consent dialog open until the work is finished", async () => {
    let finishSetup: (value: { ok: true; message: string }) => void = () => {};
    activateMock.mockReturnValue(
      new Promise<{ ok: true; message: string }>((resolve) => {
        finishSetup = resolve;
      }),
    );

    render(<Harness dto={plugin()} />);
    await userEvent.click(screen.getByRole("button", { name: "install" }));
    await userEvent.click(screen.getByRole("button", { name: "plugins.consent.confirmInstall" }));

    // setup() is still running: the button says so and the dialog has not gone.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "plugins.consent.installing" })).toHaveAttribute(
        "aria-busy",
        "true",
      ),
    );
    expect(screen.getByTestId("pending")).toHaveTextContent("busy");

    finishSetup({ ok: true, message: "activated" });

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "plugins.consent.installing" })).toBeNull(),
    );
    expect(refreshMock).toHaveBeenCalled();
  });

  it("leaves the dialog open with the error when the install itself is refused", async () => {
    installMock.mockResolvedValue({ ok: false, error: "no permission" });

    render(<Harness dto={plugin()} />);
    await userEvent.click(screen.getByRole("button", { name: "install" }));
    await userEvent.click(screen.getByRole("button", { name: "plugins.consent.confirmInstall" }));

    await waitFor(() => expect(screen.getByText("no permission")).toBeInTheDocument());
    expect(activateMock).not.toHaveBeenCalled();
    // Nothing changed on the server, so nothing to re-render.
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("refreshes the shell when a plugin is switched OFF too", async () => {
    render(
      <Harness
        dto={plugin({ installed: true, status: "ACTIVE", grantedPermissions: ["data:own"] })}
      />,
    );

    // Consent was given already, so the switch acts directly — no dialog.
    await userEvent.click(screen.getByRole("button", { name: "toggle" }));

    await waitFor(() => expect(deactivateMock).toHaveBeenCalledWith("vn.zsoft.plugin.cafe", "site"));
    // Taking a menu away as promptly as putting one there: a sidebar entry that
    // outlives the plugin behind it is a link to a screen that now 404s.
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
  });
});
