import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Block, RenderPayload } from "@zcmsorg/schemas";
import type { Theme, ThemeContext } from "@zcmsorg/theme-sdk";
import { buildThemeContext, buildUrl, renderBlocks } from "../theme-context";

/**
 * This module is the whole of a theme's access to the platform, and the block
 * renderer that runs untrusted theme components. Two things must hold: a block
 * type the theme does not know is SKIPPED, never thrown on (block types are an
 * open set), and a block that throws is isolated so the rest of the page renders.
 * buildUrl is the locale-prefixing a theme relies on and must never mangle.
 */

/** Minimal theme whose block map is supplied per test. */
function themeWith(blocks: Record<string, Theme<any>["blocks"][string]>): Theme<any> {
  return {
    manifest: { id: "vn.zsoft.theme.test", settingsSchema: { properties: {} } },
    Layout: () => null,
    templates: { page: () => null },
    blocks,
    messages: {},
  } as unknown as Theme<any>;
}

const ctx = {} as ThemeContext<any>;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("renderBlocks", () => {
  it("renders a block through the theme's matching component", () => {
    const theme = themeWith({
      "core/text": ({ props }: any) => <p>{props.text as string}</p>,
    });
    const blocks: Block[] = [
      { id: "b1", type: "core/text", props: { text: "hello" } } as Block,
    ];

    render(<>{renderBlocks(blocks, theme, ctx)}</>);

    expect(screen.getByText("hello")).toBeInTheDocument();
  });

  it("skips an unknown block type in production instead of throwing", () => {
    // A page whose theme was swapped for one that does not know a block type must
    // still serve — minus that block, never as a crash.
    vi.stubEnv("NODE_ENV", "production");
    const theme = themeWith({});
    const blocks = [{ id: "b1", type: "commerce/product-grid", props: {} }] as Block[];

    const { container } = render(<>{renderBlocks(blocks, theme, ctx)}</>);

    expect(container).toBeEmptyDOMElement();
  });

  it("isolates a throwing block so its siblings still render", () => {
    // The untrusted-code guarantee: one exploding block does not erase the others.
    vi.stubEnv("NODE_ENV", "production");
    const theme = themeWith({
      "core/text": ({ props }: any) => <p>{props.text as string}</p>,
      "community/boom": (): never => {
        throw new Error("block exploded");
      },
    });
    const blocks = [
      { id: "b1", type: "core/text", props: { text: "survivor" } },
      { id: "b2", type: "community/boom", props: {} },
    ] as Block[];

    render(<>{renderBlocks(blocks, theme, ctx)}</>);

    expect(screen.getByText("survivor")).toBeInTheDocument();
  });

  it("returns null for an empty or non-array block list", () => {
    const theme = themeWith({});

    expect(renderBlocks([], theme, ctx)).toBeNull();
    expect(renderBlocks(null as unknown as Block[], theme, ctx)).toBeNull();
  });

  it("skips a malformed block that has no string type", () => {
    vi.stubEnv("NODE_ENV", "production");
    const theme = themeWith({});
    const blocks = [{ id: "b1" }, null] as unknown as Block[];

    const { container } = render(<>{renderBlocks(blocks, theme, ctx)}</>);

    expect(container).toBeEmptyDOMElement();
  });
});

describe("buildUrl", () => {
  const site = (over: Partial<RenderPayload["site"]> = {}) =>
    ({ locale: "en", defaultLocale: "en", ...over }) as RenderPayload["site"];

  it("adds a leading slash to a relative path", () => {
    expect(buildUrl(site(), "blog")).toBe("/blog");
  });

  it("leaves the default locale unprefixed", () => {
    expect(buildUrl(site({ locale: "en", defaultLocale: "en" }), "/blog")).toBe("/blog");
  });

  it("prefixes a non-default locale with its code", () => {
    expect(buildUrl(site({ locale: "vi", defaultLocale: "en" }), "/blog")).toBe("/vi/blog");
  });

  it("passes an absolute external URL through untouched", () => {
    // An external menu item must not be locale-prefixed or slash-mangled.
    expect(buildUrl(site({ locale: "vi", defaultLocale: "en" }), "https://x.example/p")).toBe(
      "https://x.example/p",
    );
  });

  it("passes a protocol-relative URL through untouched", () => {
    expect(buildUrl(site(), "//cdn.example/x")).toBe("//cdn.example/x");
  });

  it("preserves the query string and fragment", () => {
    expect(buildUrl(site({ locale: "vi", defaultLocale: "en" }), "/blog?page=2#top")).toBe(
      "/vi/blog?page=2#top",
    );
  });

  it("strips a trailing slash but keeps the root as '/'", () => {
    expect(buildUrl(site(), "/blog/")).toBe("/blog");
    expect(buildUrl(site(), "/")).toBe("/");
  });
});

describe("buildThemeContext", () => {
  const BASE = "/theme-assets/vn.zsoft.theme.corp/1.0.0/";

  const payload = {
    site: { locale: "en", defaultLocale: "en" },
    theme: { settings: {} },
    menus: { main: [] },
    capabilities: ["comments", "ai.assistant"],
    integrations: {
      "ai.assistant": {
        capability: "ai.assistant",
        provider: { pluginKey: "vn.zsoft.plugin.zai", version: "0.2.0" },
        data: { name: "Help bot", welcomeMessage: "Hello" },
      },
    },
    alternates: [],
  } as unknown as RenderPayload;

  it("exposes the platform surface a theme is allowed to see", () => {
    const theme = themeWith({});

    const built = buildThemeContext(theme, payload, BASE);

    expect(built.site).toBe(payload.site);
    expect(built.menus).toBe(payload.menus);
    expect(built.locale).toBe("en");
  });

  it("answers hasCapability from the payload's capability list", () => {
    // A theme must not be able to claim a capability the site did not grant.
    const built = buildThemeContext(themeWith({}), payload, BASE);

    expect(built.hasCapability("comments")).toBe(true);
    expect(built.hasCapability("commerce")).toBe(false);
  });

  it("exposes public integration data without exposing plugin internals", () => {
    const built = buildThemeContext(themeWith({}), payload, BASE);

    expect(built.getIntegration<{ name: string }>("ai.assistant")?.data.name).toBe("Help bot");
    expect(built.getIntegration("commerce.products")).toBeUndefined();
  });

  it("lets the theme choose where runtime-owned integration UI is mounted", () => {
    const built = buildThemeContext(themeWith({}), payload, BASE);

    render(<>{built.renderSlot("floating")}</>);

    expect(screen.getByRole("button", { name: "Open Help bot" })).toBeInTheDocument();
  });

  it("adapts the previous zAI payload shape during the compatibility window", () => {
    const legacy = {
      ...payload,
      integrations: undefined,
      aiAssistant: { name: "Legacy bot", welcomeMessage: "Welcome" },
    } as unknown as RenderPayload;
    const built = buildThemeContext(themeWith({}), legacy, BASE);

    expect(built.getIntegration<{ name: string }>("ai.assistant")?.data.name).toBe("Legacy bot");
  });

  it("hands the theme a locale-aware url() builder", () => {
    const built = buildThemeContext(
      themeWith({}),
      { ...payload, site: { locale: "vi", defaultLocale: "en" } as RenderPayload["site"] },
      BASE,
    );

    expect(built.url("/blog")).toBe("/vi/blog");
  });

  it("resolves a theme's own files against the base the loader gave it", () => {
    // How a theme renders its logo without knowing where it was installed. The
    // base differs per theme, which is what keeps one theme's icons out of
    // another's site.
    const built = buildThemeContext(themeWith({}), payload, BASE);

    expect(built.asset("assets/logo.png")).toBe(`${BASE}assets/logo.png`);
  });

  it("passes an already-absolute asset URL through untouched", () => {
    // An owner's uploaded logo. Rewriting it under the theme's bundle would 404.
    const built = buildThemeContext(themeWith({}), payload, BASE);

    expect(built.asset("/uploads/logo.png")).toBe("/uploads/logo.png");
  });
});
