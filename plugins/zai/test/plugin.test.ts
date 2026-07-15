import { describe, expect, it, vi } from "vitest";
import plugin from "../src";

/**
 * zAI is the plugin that proves `network:fetch` works, so these tests are mostly
 * about what it CANNOT do. It talks to three paid APIs and holds none of their keys.
 */

const SITE = { id: "site-1", name: "Main", locale: "vi" };

/**
 * A context shaped like the sandbox's.
 *
 * Note `settings` has no `openaiApiKey`: the real runtime strips password-format
 * settings before the isolate starts, so a test that supplied one would be testing a
 * plugin that cannot exist. `secrets` is the boolean view the plugin actually gets.
 */
function makeCtx(over: Record<string, unknown> = {}) {
  const fetch = vi.fn().mockResolvedValue({
    status: 200,
    headers: {},
    body: JSON.stringify({ output_text: "Xin chào!" }),
  });

  return {
    ctx: {
      site: SITE,
      settings: {
        defaultProvider: "openai",
        openaiEnabled: true,
        openaiModel: "gpt-4.1-mini",
        claudeEnabled: false,
        geminiEnabled: false,
        systemPrompt: "Be helpful.",
        ...over,
      },
      secrets: { openaiKey: true, claudeKey: false, geminiKey: false },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      http: { fetch },
      storage: {} as never,
      content: {} as never,
      jobs: {} as never,
      mail: {} as never,
    } as never,
    fetch,
  };
}

describe("zAI manifest", () => {
  it("declares its three hosts, and asks for nothing but the network", () => {
    expect(plugin.manifest).toMatchObject({
      id: "vn.zsoft.plugin.zai",
      version: "0.3.0",
      capabilities: ["ai.assistant"],
      permissions: ["network:fetch"],
    });

    // The blast radius, in full. An admin approving zAI approves exactly this.
    expect(plugin.manifest.network?.hosts).toEqual([
      "api.openai.com",
      "api.anthropic.com",
      "generativelanguage.googleapis.com",
    ]);
    // And no entry that means "anywhere".
    expect(plugin.manifest.network?.hosts).not.toContain("*");
  });

  it("maps its API keys as secrets it may spend but not read", () => {
    expect(plugin.manifest.network?.secrets).toEqual({
      openaiKey: "openaiApiKey",
      claudeKey: "claudeApiKey",
      geminiKey: "geminiApiKey",
    });
  });
});

describe("zAI chat", () => {
  it("sends the key as a placeholder, never as a value", async () => {
    // THE test. The plugin authenticates to OpenAI without ever holding the
    // credential: it writes `{{secret:openaiKey}}` and the gateway substitutes it on
    // the far side of the sandbox boundary. If someone ever "simplifies" this by
    // reading ctx.settings.openaiApiKey, the header stops being a placeholder and
    // this fails.
    const { ctx, fetch } = makeCtx();

    await plugin.calls!.chat({ messages: [{ role: "user", content: "Hi" }] }, ctx);

    expect(fetch).toHaveBeenCalledTimes(1);
    const request = fetch.mock.calls[0][0];
    expect(request.url).toBe("https://api.openai.com/v1/responses");
    expect(request.headers.authorization).toBe("Bearer {{secret:openaiKey}}");

    // Nothing key-shaped anywhere in what left the sandbox.
    expect(JSON.stringify(request)).not.toMatch(/sk-|AIza/);
  });

  it("picks a provider from ctx.secrets, not from a key it cannot see", async () => {
    // The admin enabled Gemini and filled its key in; OpenAI is off. The plugin knows
    // WHICH keys exist without knowing WHAT they are — that is what ctx.secrets is.
    const { ctx, fetch } = makeCtx({
      defaultProvider: "gemini",
      openaiEnabled: false,
      geminiEnabled: true,
      geminiModel: "gemini-2.5-flash",
    });
    (ctx as never as { secrets: Record<string, boolean> }).secrets = {
      openaiKey: false,
      claudeKey: false,
      geminiKey: true,
    };
    fetch.mockResolvedValue({
      status: 200,
      headers: {},
      body: JSON.stringify({ candidates: [{ content: { parts: [{ text: "Chào bạn" }] } }] }),
    });

    const res = (await plugin.calls!.chat(
      { messages: [{ role: "user", content: "Hi" }] },
      ctx,
    )) as { answer: string; provider: string };

    expect(res).toEqual({ answer: "Chào bạn", provider: "gemini" });
    expect(fetch.mock.calls[0][0].headers["x-goog-api-key"]).toBe("{{secret:geminiKey}}");
  });

  it("keeps the admin-configured prompt while appending core grounding context", async () => {
    const { ctx, fetch } = makeCtx({ systemPrompt: "Use a warm brand voice." });

    await plugin.calls!.chat(
      {
        systemPrompt: "Use only the public context below.",
        messages: [{ role: "user", content: "What plans are public?" }],
      },
      ctx,
    );

    expect(fetch.mock.calls[0][0].body.instructions).toContain("Use a warm brand voice.");
    expect(fetch.mock.calls[0][0].body.instructions).toContain("Use only the public context below.");
  });

  it("refuses a provider the admin enabled but never gave a key to", async () => {
    // Without ctx.secrets the plugin would have to fire a request at Claude and read
    // a 401 to discover the box was empty. It can answer that question locally.
    const { ctx, fetch } = makeCtx({ defaultProvider: "claude", claudeEnabled: true });

    await expect(
      plugin.calls!.chat({ messages: [{ role: "user", content: "Hi" }] }, ctx),
    ).resolves.toMatchObject({ provider: "openai" }); // falls back to the configured one

    (ctx as never as { settings: Record<string, unknown> }).settings.openaiEnabled = false;
    await expect(
      plugin.calls!.chat({ messages: [{ role: "user", content: "Hi" }] }, ctx),
    ).rejects.toThrow("No AI provider is enabled and configured.");

    expect(fetch).toHaveBeenCalledTimes(1); // the failing case never reached the wire
  });

  it("surfaces the provider's own error rather than a bare status code", async () => {
    const { ctx, fetch } = makeCtx();
    fetch.mockResolvedValue({
      status: 401,
      headers: {},
      body: JSON.stringify({ error: { message: "Incorrect API key provided." } }),
    });

    await expect(
      plugin.calls!.chat({ messages: [{ role: "user", content: "Hi" }] }, ctx),
    ).rejects.toThrow("Incorrect API key provided.");
  });

  it("lets the caller add stricter system instructions (the admin content operator does)", async () => {
    const { ctx, fetch } = makeCtx();

    await plugin.calls!.chat(
      { messages: [{ role: "user", content: "list pages" }], systemPrompt: "You are an operator." },
      ctx,
    );

    expect(fetch.mock.calls[0][0].body.instructions).toContain("Be helpful.");
    expect(fetch.mock.calls[0][0].body.instructions).toContain("You are an operator.");
  });
});

describe("zAI setup", () => {
  it("activates and says so", async () => {
    const { ctx } = makeCtx();
    await plugin.setup?.(ctx);
    expect((ctx as never as { log: { info: ReturnType<typeof vi.fn> } }).log.info)
      .toHaveBeenCalledWith(expect.stringContaining("zAI activated"));
  });
});
