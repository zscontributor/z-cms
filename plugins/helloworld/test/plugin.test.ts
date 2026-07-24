import { describe, expect, it, vi } from "vitest";
import plugin from "../src";

const SITE = { id: "site-1", name: "Main site", locale: "vi" };

function makeCtx(overrides: Record<string, unknown> = {}) {
  const storage = {
    set: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  const content = {
    get: vi.fn().mockResolvedValue({ id: "content-1", title: "Welcome page" }),
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  return {
    ctx: {
      site: SITE,
      settings: {
        greeting: "Xin chao",
        includeSiteName: true,
        ...overrides,
      },
      storage,
      content,
      log,
      jobs: {} as never,
      mail: {} as never,
      http: {} as never,
      secrets: {},
    } as never,
    storage,
    content,
    log,
  };
}

describe("HelloWorld plugin package", () => {
  it("declares a minimal reviewable manifest", () => {
    expect(plugin.manifest).toMatchObject({
      id: "vn.zsoft.plugin.helloworld",
      name: "HelloWorld",
      version: "0.1.0",
      permissions: ["content:read"],
      capabilities: ["demo.hello"],
    });
  });

  it("records a greeting when content is published", async () => {
    const { ctx, storage, log } = makeCtx();

    await plugin.actions!["content.published"]!(
      {
        siteId: SITE.id,
        contentId: "content-1",
        contentType: "page",
        title: "Fallback title",
        path: "/welcome",
        publishedAt: "2026-07-15T00:00:00.000Z",
      },
      ctx,
    );

    expect(storage.set).toHaveBeenCalledWith("hello:content-1", {
      contentId: "content-1",
      path: "/welcome",
      message: "Xin chao on Main site: Welcome page",
      greetedAt: "2026-07-15T00:00:00.000Z",
    });
    expect(log.info).toHaveBeenCalledWith("Xin chao on Main site: Welcome page");
  });

  it("cleans up its own storage when content is deleted", async () => {
    const { ctx, storage } = makeCtx();

    await plugin.actions!["content.deleted"]!(
      { siteId: SITE.id, contentId: "content-1" },
      ctx,
    );

    expect(storage.delete).toHaveBeenCalledWith("hello:content-1");
  });
});
