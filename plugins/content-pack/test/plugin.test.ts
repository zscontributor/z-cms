import { describe, expect, it } from "vitest";
import plugin from "../src";

/**
 * A minimal in-memory PluginContext double. It implements only the surface the
 * plugin actually touches — content.list, storage, jobs, log, settings — which is
 * exactly the point of the read-only contract: there is little else to fake.
 */
function makeCtx(items: any[], settings: Partial<Record<string, unknown>> = {}) {
  const store = new Map<string, unknown>();
  const enqueued: string[] = [];
  return {
    ctx: {
      settings: {
        requiredLocales: "en,vi,ja",
        contentTypes: "page,post",
        warnOnGaps: true,
        ...settings,
      },
      site: { id: "s1", name: "Test Site", locale: "en" },
      secrets: {},
      log: { info() {}, warn() {}, error() {} },
      storage: {
        async get(key: string) {
          return (store.get(key) ?? null) as never;
        },
        async set(key: string, value: unknown) {
          store.set(key, value);
        },
        async delete(key: string) {
          store.delete(key);
        },
        async list() {
          return [];
        },
      },
      content: {
        async get() {
          return null;
        },
        async list(query?: { contentTypeKey?: string; page?: number; perPage?: number }) {
          const page = query?.page ?? 1;
          if (page > 1) return [] as never;
          const filtered = query?.contentTypeKey
            ? items.filter((i) => i.contentType.key === query.contentTypeKey)
            : items;
          return filtered as never;
        },
      },
      jobs: {
        async enqueue(name: string) {
          enqueued.push(name);
        },
      },
      mail: { async send() { return { queued: true } as const; } },
      http: { async fetch() { return { status: 200, headers: {}, body: "" }; } },
    } as any,
    store,
    enqueued,
  };
}

function content(translationGroupId: string, locale: string, key: string, title: string) {
  return {
    id: `${translationGroupId}-${locale}`,
    translationGroupId,
    locale,
    title,
    slug: title.toLowerCase(),
    path: `/${title.toLowerCase()}`,
    contentType: { id: key, key, name: key },
    seo: {},
    status: "PUBLISHED",
    data: {},
    blocks: [],
  };
}

const FIXTURES = [
  // Complete across en/vi/ja
  content("g-home", "en", "page", "Home"),
  content("g-home", "vi", "page", "Trang chu"),
  content("g-home", "ja", "page", "Home JA"),
  // Missing ja
  content("g-about", "en", "page", "About"),
  content("g-about", "vi", "page", "Gioi thieu"),
  // A post missing vi + ja
  content("g-post", "en", "post", "Post One"),
];

describe("Z-SOFT Content Pack", () => {
  it("declares a read-only manifest identity", () => {
    expect(plugin.manifest).toMatchObject({
      id: "vn.zsoft.plugin.content-pack",
      permissions: ["content:read"],
      capabilities: ["content.audit"],
    });
    // The whole point: it asks for no write scope of any kind.
    expect(plugin.manifest.permissions).not.toContain("content:create");
    expect(plugin.manifest.permissions).not.toContain("content:update");
  });

  it("audits language coverage and stores a report with the real gaps", async () => {
    const { ctx, store } = makeCtx(FIXTURES);
    await plugin.jobs!.audit({}, ctx);

    const report: any = store.get("audit:report");
    expect(report).toBeTruthy();
    expect(report.requiredLocales).toEqual(["en", "vi", "ja"]);
    expect(report.totalGroups).toBe(3);
    expect(report.complete).toBe(1);
    expect(report.incomplete).toBe(2);

    const byGroup = Object.fromEntries(report.gaps.map((g: any) => [g.translationGroup, g]));
    expect(byGroup["g-about"].missing).toEqual(["ja"]);
    expect(byGroup["g-post"].missing).toEqual(["vi", "ja"]);
    expect(byGroup["g-home"]).toBeUndefined(); // complete groups are not gaps
  });

  it("exposes the report on demand via the content.audit call", async () => {
    const { ctx } = makeCtx(FIXTURES);
    const report: any = await plugin.calls!.report({}, ctx);
    expect(report.totalGroups).toBe(3);
    expect(report.complete).toBe(1);
  });

  it("re-audits when content is published, off the request path", async () => {
    const { ctx, enqueued } = makeCtx(FIXTURES);
    await plugin.actions!["content.published"]!(
      { contentId: "x", path: "/about", title: "About", publishedAt: new Date().toISOString() } as any,
      ctx,
    );
    expect(enqueued).toContain("audit");
  });
});
