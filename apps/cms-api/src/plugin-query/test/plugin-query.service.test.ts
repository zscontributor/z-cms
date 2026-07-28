import { beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";

const holder = vi.hoisted(() => ({ systemDb: null as any }));
vi.mock("@zcmsorg/database", () => ({ getSystemDb: () => holder.systemDb }));

import { PluginQueryService } from "../plugin-query.service";

const HOST = "shop.example";

function publishedDomain() {
  return {
    domain: {
      findUnique: vi.fn().mockResolvedValue({
        hostname: HOST,
        site: { id: "s1", tenantId: "t1", status: "PUBLISHED", defaultLocale: "en" },
      }),
    },
  };
}

function makePlugins(result: unknown) {
  return { callCapability: vi.fn().mockResolvedValue(result) };
}

describe("PluginQueryService.run", () => {
  beforeEach(() => {
    holder.systemDb = publishedDomain();
  });

  it("dispatches the sanitized filter to the capability's `query` call and returns items", async () => {
    const plugins = makePlugins([{ id: "1" }, { id: "2" }]);
    const service = new PluginQueryService(plugins as never);

    const out = await service.run(HOST, "catalog.search", { stage: "lead", hostname: HOST, junk: 5 });

    expect(out).toEqual({ items: [{ id: "1" }, { id: "2" }] });
    // hostname is dropped; a non-string param is dropped; the call name is fixed.
    expect(plugins.callCapability).toHaveBeenCalledWith("t1", "s1", "catalog.search", "query", {
      params: { stage: "lead" },
    });
  });

  it("normalizes an { items } result shape", async () => {
    const plugins = makePlugins({ items: [{ id: "x" }], total: 1 });
    const service = new PluginQueryService(plugins as never);
    expect(await service.run(HOST, "catalog.search", {})).toEqual({ items: [{ id: "x" }] });
  });

  it("yields no rows when the handler returns something unexpected", async () => {
    const service = new PluginQueryService(makePlugins("nope") as never);
    expect(await service.run(HOST, "catalog.search", {})).toEqual({ items: [] });
  });

  it("400s when the hostname is missing", async () => {
    const service = new PluginQueryService(makePlugins([]) as never);
    await expect(service.run("", "catalog.search", {})).rejects.toBeInstanceOf(BadRequestException);
  });

  it("404s an invalid capability id before touching the database", async () => {
    const service = new PluginQueryService(makePlugins([]) as never);
    await expect(service.run(HOST, "Bad Cap!", {})).rejects.toBeInstanceOf(NotFoundException);
  });

  it("404s a site that is not published", async () => {
    holder.systemDb = { domain: { findUnique: vi.fn().mockResolvedValue(null) } };
    const service = new PluginQueryService(makePlugins([]) as never);
    await expect(service.run(HOST, "catalog.search", {})).rejects.toBeInstanceOf(NotFoundException);
  });
});
