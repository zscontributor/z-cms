import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/i18n-provider", () => ({
  useT: () => (key: string) => key,
  useLocale: () => "en",
}));

import { ReferenceField } from "../reference-field";

/**
 * The picker's fetch, as the browser actually makes it.
 *
 * "Staff member" on a shift was empty in production and fine in dev. Two things
 * had to be true at once for that, and both are asserted here because either one
 * alone reproduces the same blank box:
 *
 *   1. the admin serves nothing at a bare `/api/plugin-admin/…` — it is under a
 *      base path, `/admin` by default in production;
 *   2. a non-OK response was rendered as "No matches.", so a 404 and an empty
 *      table were indistinguishable from inside the dropdown.
 */

function mockFetch(impl: (url: string) => Partial<Response> & { json: () => Promise<unknown> }) {
  const spy = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : String(input);
    return { ok: true, status: 200, ...impl(url) } as Response;
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

const props = {
  pluginKey: "vn.zsoft.plugin.cafe",
  resourceKey: "shifts",
  column: "staff_id",
  value: "",
  onChange: () => {},
};

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("ReferenceField", () => {
  it("asks the admin's own base path, not the bare origin", async () => {
    const spy = mockFetch(() => ({ json: async () => ({ options: [] }) }));
    render(<ReferenceField {...props} />);

    screen.getByRole("textbox").focus();

    await waitFor(
      () => {
        expect(spy).toHaveBeenCalled();
      },
      { timeout: 2000 },
    );
    const url = String(spy.mock.calls[0]![0]);
    // The exact shape of the request that 404'd in production.
    expect(url).toContain("/admin/api/plugin-admin/vn.zsoft.plugin.cafe/shifts/options/staff_id");
    expect(url.startsWith("/api/")).toBe(false);
  });

  it("says the list is forbidden rather than empty when the server says 403", async () => {
    mockFetch(() => ({ ok: false, status: 403, json: async () => ({ options: [] }) }));
    render(<ReferenceField {...props} />);

    screen.getByRole("textbox").focus();

    // A picker gated by the permission of the table it points AT can be refused on
    // a screen the reader is allowed to open. Drawing that as "no matches" is what
    // made this invisible to everyone who could have fixed it.
    await waitFor(
      () => {
        expect(screen.getByText("plugins.resource.referenceForbidden")).toBeTruthy();
      },
      { timeout: 2000 },
    );
  });

  it("says 'no matches' for a genuinely empty list", async () => {
    mockFetch(() => ({ json: async () => ({ options: [] }) }));
    render(<ReferenceField {...props} />);

    screen.getByRole("textbox").focus();

    await waitFor(
      () => {
        expect(screen.getByText("plugins.resource.referenceEmpty")).toBeTruthy();
      },
      { timeout: 2000 },
    );
  });

  it("lists what the server returned", async () => {
    mockFetch(() => ({
      json: async () => ({ options: [{ value: "s-1", label: "Lê Minh Thư" }] }),
    }));
    render(<ReferenceField {...props} />);

    screen.getByRole("textbox").focus();

    await waitFor(
      () => {
        expect(screen.getByText("Lê Minh Thư")).toBeTruthy();
      },
      { timeout: 2000 },
    );
  });

  it("resolves a stored id to its name, so a saved row does not show a uuid", async () => {
    const spy = mockFetch((url) => ({
      json: async () =>
        url.includes("value=")
          ? { options: [{ value: "s-1", label: "Lê Minh Thư" }] }
          : { options: [] },
    }));
    render(<ReferenceField {...props} value="s-1" />);

    await waitFor(
      () => {
        expect(screen.getByRole("textbox")).toHaveValue("Lê Minh Thư");
      },
      { timeout: 2000 },
    );
    expect(String(spy.mock.calls[0]![0])).toContain("value=s-1");
  });
});
