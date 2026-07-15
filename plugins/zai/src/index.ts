import { definePlugin, type PluginContext } from "@zcmsorg/plugin-sdk";

/**
 * zAI: an AI assistant that reaches OpenAI, Claude or Gemini.
 *
 * This plugin is why `network:fetch` exists, and it is the test of whether that
 * design actually holds. Until now these three provider calls lived in
 * `apps/cms-api/src/ai/ai.module.ts` — in core, with `const ZAI_KEY` hard-coded
 * into it — because there was no other way for a plugin to reach the internet. The
 * real rule for the marketplace was therefore: *you may call an external service if
 * Z-SOFT writes a NestJS module for you*. That is not a marketplace.
 *
 * The requests now live here, in the sandbox. Note what this plugin does NOT have,
 * despite being the one that talks to three paid APIs:
 *
 *   - **No socket.** `ctx.http.fetch` is an RPC. cms-api is what dials, after it has
 *     checked the host against the `network.hosts` below.
 *   - **No API keys.** The three key settings are `format: "password"`, so they are
 *     stripped from `ctx.settings` before this code starts. The plugin writes
 *     `{{secret:openaiKey}}` and never learns what it expands to.
 *   - **No way anywhere else.** Three hosts, named in the manifest, approved by an
 *     admin at install. Everything else is refused at the gateway.
 *
 * So a compromised zAI can spend the site's OpenAI quota. It cannot steal the key,
 * and it cannot post the site's content to an attacker's server.
 */

type Provider = "openai" | "claude" | "gemini";
type ChatMessage = { role: "user" | "assistant"; content: string };

/**
 * What the plugin can actually read.
 *
 * The absence of `openaiApiKey` and friends is the point. They exist in the
 * manifest's settingsSchema and an admin fills them in — they are simply not
 * things this code is allowed to see, so they are not on this interface.
 */
interface ZaiSettings {
  assistantName: string;
  welcomeMessage: string;
  systemPrompt: string;
  contentManagementEnabled: boolean;
  defaultProvider: Provider;
  openaiEnabled: boolean;
  openaiModel: string;
  claudeEnabled: boolean;
  claudeModel: string;
  geminiEnabled: boolean;
  geminiModel: string;
}

type Ctx = PluginContext<ZaiSettings>;

const ENABLED_FLAG: Record<Provider, keyof ZaiSettings> = {
  openai: "openaiEnabled",
  claude: "claudeEnabled",
  gemini: "geminiEnabled",
};

/** Manifest secret name per provider — what `ctx.secrets` is keyed by. */
const SECRET_NAME: Record<Provider, string> = {
  openai: "openaiKey",
  claude: "claudeKey",
  gemini: "geminiKey",
};

/**
 * The provider to use: enabled by the admin, and actually holding a key.
 *
 * `ctx.secrets` is how the plugin knows the second half. It cannot see the keys, so
 * it cannot work that out for itself — the host answers "is it configured?" while
 * still refusing "what is it?". Without that, picking a provider would mean firing
 * a request at OpenAI and reading a 401 to discover the admin left the box blank.
 */
function selectProvider(settings: ZaiSettings, secrets: Record<string, boolean>): Provider {
  const enabled = (Object.keys(ENABLED_FLAG) as Provider[]).filter(
    (provider) =>
      settings[ENABLED_FLAG[provider]] === true && secrets[SECRET_NAME[provider]] === true,
  );
  const preferred = settings.defaultProvider;
  const provider = preferred && enabled.includes(preferred) ? preferred : enabled[0];
  if (!provider) throw new Error("No AI provider is enabled and configured.");
  return provider;
}

export default definePlugin<ZaiSettings>({
  manifest: {
    id: "vn.zsoft.plugin.zai",
    name: "zAI",
    version: "0.3.0",
    author: { name: "Z-SOFT Co., Ltd" },
    engine: ">=0.1.0",
    permissions: ["network:fetch"],
    capabilities: ["ai.assistant"],
    network: {
      // Three hosts, named. An admin approving zAI approves exactly these: the
      // consent screen lists them and the gateway refuses everything else. There is
      // no entry here that means "and anywhere else the plugin fancies" — `*` is
      // refused at install.
      hosts: ["api.openai.com", "api.anthropic.com", "generativelanguage.googleapis.com"],
      // The bargain: the plugin spends these, and cannot read them.
      secrets: {
        openaiKey: "openaiApiKey",
        claudeKey: "claudeApiKey",
        geminiKey: "geminiApiKey",
      },
    },
  },

  calls: {
    /**
     * Answers one chat turn.
     *
     * cms-api reaches this through the `ai.assistant` capability — it asks whichever
     * plugin provides that, and no longer knows this one by name.
     */
    async chat(payload, ctx) {
      const messages = (payload.messages ?? []) as ChatMessage[];
      const system = [
        ctx.settings.systemPrompt ||
          "You are a helpful assistant for this website. Answer in the visitor's language.",
        typeof payload.systemPrompt === "string" ? payload.systemPrompt : "",
      ].filter(Boolean).join("\n\n");

      const provider = selectProvider(ctx.settings, ctx.secrets);
      const answer = await ask(provider, system, messages, ctx);
      if (!answer) throw new Error("The AI provider returned an empty response.");

      return { answer, provider };
    },
  },

  setup: (ctx) => {
    ctx.log.info(`zAI activated on site "${ctx.site.name}".`);
  },
});

async function ask(
  provider: Provider,
  system: string,
  messages: ChatMessage[],
  ctx: Ctx,
): Promise<string> {
  if (provider === "openai") {
    const data = (await post(
      ctx,
      "https://api.openai.com/v1/responses",
      { authorization: "Bearer {{secret:openaiKey}}" },
      {
        model: ctx.settings.openaiModel || "gpt-4.1-mini",
        instructions: system,
        input: messages.map((message) => ({
          role: message.role,
          content: [
            {
              type: message.role === "assistant" ? "output_text" : "input_text",
              text: message.content,
            },
          ],
        })),
      },
    )) as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };

    return (
      data.output_text ??
      (data.output ?? [])
        .flatMap((item) => item.content ?? [])
        .map((item) => item.text ?? "")
        .join("\n")
        .trim()
    );
  }

  if (provider === "claude") {
    const data = (await post(
      ctx,
      "https://api.anthropic.com/v1/messages",
      { "x-api-key": "{{secret:claudeKey}}", "anthropic-version": "2023-06-01" },
      {
        model: ctx.settings.claudeModel || "claude-sonnet-4-5",
        max_tokens: 1_024,
        system,
        messages,
      },
    )) as { content?: Array<{ type?: string; text?: string }> };

    return (data.content ?? [])
      .filter((item) => item.type === "text")
      .map((item) => item.text ?? "")
      .join("\n")
      .trim();
  }

  const model = encodeURIComponent(ctx.settings.geminiModel || "gemini-2.5-flash");
  const data = (await post(
    ctx,
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    { "x-goog-api-key": "{{secret:geminiKey}}" },
    {
      systemInstruction: { parts: [{ text: system }] },
      contents: messages.map((message) => ({
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text: message.content }],
      })),
    },
  )) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };

  return (data.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
}

/**
 * One POST through the host.
 *
 * `{{secret:...}}` in those headers is not a value this code holds — it is a
 * request TO the host to put the admin's key there, which it does on the far side
 * of the sandbox boundary, after it has approved the hostname.
 */
async function post(
  ctx: Ctx,
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<unknown> {
  const res = await ctx.http.fetch({ url, method: "POST", headers, body });
  const data = JSON.parse(res.body || "{}") as { error?: { message?: string } | string };

  if (res.status < 200 || res.status >= 300) {
    const message = typeof data.error === "string" ? data.error : data.error?.message;
    throw new Error(message || `The AI provider failed with HTTP ${res.status}.`);
  }
  return data;
}
