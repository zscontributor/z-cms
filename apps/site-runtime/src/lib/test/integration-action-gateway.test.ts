import { beforeEach, describe, expect, it, vi } from "vitest";

const headerValues = new Headers();
vi.mock("next/headers", () => ({
  headers: async () => headerValues,
}));

import { postIntegrationAction } from "@/lib/integration-action-gateway";

const TOKEN = "site-runtime-token";
const API = "http://cms-api.test:4100";

function post(capability = "ai.assistant", action = "chat") {
  return postIntegrationAction(
    new Request("http://site.test/integrations/ai.assistant/actions/chat", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "Hello" }] }),
    }),
    { params: Promise.resolve({ capability, action }) },
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubEnv("CMS_API_URL", API);
  vi.stubEnv("CMS_INTERNAL_TOKEN", TOKEN);
  headerValues.delete("host");
  headerValues.delete("x-forwarded-host");
  headerValues.delete("x-forwarded-for");
  headerValues.set("host", "site.test");
});

describe("postIntegrationAction", () => {
  it("proxies the public assistant action to cms-api's internal capability route", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ answer: "Hi" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const res = await post();
    const body = await res.json() as { answer: string };

    expect(res.status).toBe(200);
    expect(body.answer).toBe("Hi");
    const [url, init] = fetch.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe(`${API}/api/v1/integrations/ai.assistant/actions/chat?hostname=site.test`);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "X-Internal-Token": TOKEN,
      "content-type": "application/json",
    });
  });

  it("uses the forwarded host and forwards the client IP when a proxy provides them", async () => {
    headerValues.set("x-forwarded-host", "Portal.Example");
    headerValues.set("x-forwarded-for", "203.0.113.10");
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ answer: "Hi" }), { status: 200 }),
    );

    await post();

    const [url, init] = fetch.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe(`${API}/api/v1/integrations/ai.assistant/actions/chat?hostname=portal.example`);
    expect(init.headers).toMatchObject({ "x-forwarded-for": "203.0.113.10" });
  });

  it("refuses unknown capabilities and actions instead of proxying them", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");

    expect((await post("comments", "create")).status).toBe(404);
    expect((await post("ai.assistant", "delete")).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requires a hostname before calling cms-api", async () => {
    headerValues.delete("host");
    const fetch = vi.spyOn(globalThis, "fetch");

    const res = await post();

    expect(res.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});
