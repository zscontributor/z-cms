import { definePlugin } from "@zcmsorg/plugin-sdk";

/**
 * Z SEO — the reference plugin.
 *
 * It exists to prove the contract is usable, and it deliberately exercises every
 * mechanism a real plugin has:
 *
 *   - a FILTER  (content.seo)        — transforms a value in the render path
 *   - an ACTION (content.published)  — reacts after the fact, off the hot path
 *   - STORAGE                        — its own namespaced rows, no core tables
 *   - the CONTENT API                — under the one scope it asked for
 *   - SETTINGS                       — a form the admin renders from JSON Schema
 *   - a CAPABILITY (seo.metadata)    — themes feature-detect on it
 *
 * Note what is absent: no `require("fs")`, no database handle, no `process.env`,
 * no network client. Not because the author was polite — because the sandbox
 * does not provide them.
 */

interface SeoSettings {
  titleSuffix: string;
  defaultDescription: string;
  noindexDrafts: boolean;
}

export default definePlugin<SeoSettings>({
  manifest: {
    id: "vn.zsoft.plugin.seo",
    name: "Z SEO",
    version: "0.1.0",
    author: { name: "Z-SOFT Co., Ltd" },
    engine: ">=0.1.0",
    permissions: ["content:read"],
    capabilities: ["seo.metadata"],
  },

  filters: {
    /**
     * Fills the gaps in a page's SEO, without ever overriding what an editor
     * wrote by hand. A plugin that silently replaced an author's title would be
     * a bug, not a feature.
     */
    "content.seo": (seo, context, ctx) => {
      const suffix = ctx.settings.titleSuffix ?? "";
      const title = seo.title ?? context.title;

      const description =
        seo.description ?? ctx.settings.defaultDescription ?? undefined;

      return {
        ...seo,
        title: title.endsWith(suffix) ? title : `${title}${suffix}`,
        description,
        // Only ever ADDS noindex, never removes one the editor set.
        noindex:
          seo.noindex ||
          (ctx.settings.noindexDrafts === true && !seo.description),
      };
    },
  },

  actions: {
    /**
     * Keeps an audit of pages whose SEO is thin, so the admin has something to
     * act on. Runs off the request path — the editor's publish already returned.
     */
    "content.published": async (event, ctx) => {
      const content = await ctx.content.get(event.contentId);
      if (!content) return;

      const issues: string[] = [];
      const seo = content.seo ?? {};

      if (!seo.description) issues.push("missing meta description");
      if (!seo.title) issues.push("missing meta title");
      if (content.title.length > 60) issues.push("title longer than 60 characters");

      await ctx.storage.set(`audit:${event.contentId}`, {
        path: event.path,
        title: event.title,
        issues,
        checkedAt: event.publishedAt,
      });

      if (issues.length > 0) {
        ctx.log.warn(`SEO needs work: ${event.path} — ${issues.join(", ")}`);
      } else {
        ctx.log.info(`SEO looks good: ${event.path}`);
      }
    },

    "content.unpublished": async (event, ctx) => {
      await ctx.storage.delete(`audit:${event.contentId}`);
    },
  },

  jobs: {
    // A deferred job the plugin can schedule with ctx.jobs.enqueue("recheck-all").
    // It runs in the sandbox, off the request path, and re-audits every published
    // page's SEO — the kind of sweep that has no business blocking a web request.
    "recheck-all": async (_payload, ctx) => {
      const items = await ctx.content.list({ status: "PUBLISHED", perPage: 50 });
      let thin = 0;
      for (const item of items) {
        const seo = item.seo ?? {};
        const issues = [];
        if (!seo.description) issues.push("missing meta description");
        if (!seo.title) issues.push("missing meta title");
        if (issues.length) thin++;
        await ctx.storage.set("audit:" + item.id, {
          path: item.path, title: item.title, issues, checkedAt: item.updatedAt,
        });
      }
      ctx.log.info("SEO recheck: audited " + items.length + " pages, " + thin + " need work");
    },
  },

  setup: async (ctx) => {
    await ctx.storage.set("installed", { at: new Date().toISOString() });
    ctx.log.info(`Z SEO activated on site "${ctx.site.name}".`);
  },
});
