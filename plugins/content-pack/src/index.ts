import { definePlugin } from "@zcmsorg/plugin-sdk";
import type { PluginContext } from "@zcmsorg/plugin-sdk";

/**
 * Z-SOFT Content Pack — the companion to the Z-SOFT theme.
 *
 * WHAT IT IS NOT. It is not a content importer. In Z-CMS a plugin has read-only
 * access to content: the plugin gateway grants `content:read` and nothing more, and
 * the sandbox exposes only `ctx.content.get` / `ctx.content.list`. There is no route
 * by which a plugin can create a page or a post — by design. The pages, posts and
 * menus of the Z-SOFT multi-page site are therefore seeded by the THEME's demo block
 * ("Appearance → Seed demo content"), which cms-api imports directly. This plugin
 * exists alongside that.
 *
 * WHAT IT DOES. A multi-language site is only as good as its least-translated page.
 * This plugin audits every page/post and checks it exists in each language you
 * require (en/vi/ja by default), grouping the language versions by their translation
 * group. It writes a coverage report to its own namespaced storage, warns in the log
 * when a language is missing, and exposes the report as a `content.audit` service any
 * tool (or the Admin AI) can call. Everything it touches is under the single
 * `content:read` scope it declares — no writes, no network, no database handle.
 */

interface ContentPackSettings {
  requiredLocales: string;
  contentTypes: string;
  warnOnGaps: boolean;
}

type Ctx = PluginContext<ContentPackSettings>;

interface GroupCoverage {
  translationGroup: string;
  contentType: string;
  title: string;
  have: string[];
  missing: string[];
}

interface CoverageReport {
  checkedAt: string;
  requiredLocales: string[];
  totalGroups: number;
  complete: number;
  incomplete: number;
  gaps: GroupCoverage[];
}

/** Split a comma/space separated setting into a clean, de-duplicated list. */
function splitList(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
}

/** Pull every published item, one page at a time — a plugin gets no unbounded query. */
async function listAllPublished(ctx: Ctx, contentTypeKey?: string) {
  const perPage = 100;
  const all: Awaited<ReturnType<Ctx["content"]["list"]>> = [];
  for (let page = 1; page <= 50; page++) {
    const batch = await ctx.content.list({ status: "PUBLISHED", contentTypeKey, perPage, page });
    all.push(...batch);
    if (batch.length < perPage) break;
  }
  return all;
}

/** The whole audit, shared by the job and the on-demand call. */
async function buildReport(ctx: Ctx): Promise<CoverageReport> {
  const required = splitList(ctx.settings.requiredLocales);
  const types = splitList(ctx.settings.contentTypes);

  const items = types.length
    ? (await Promise.all(types.map((t) => listAllPublished(ctx, t)))).flat()
    : await listAllPublished(ctx);

  // Group the language versions of one logical page by their translation group.
  const groups = new Map<string, GroupCoverage>();
  for (const item of items) {
    const key = item.translationGroupId;
    const existing = groups.get(key);
    if (existing) {
      if (!existing.have.includes(item.locale)) existing.have.push(item.locale);
      // Prefer a title in a required locale order for a stable, readable report.
      if (required.indexOf(item.locale) === 0) existing.title = item.title;
    } else {
      groups.set(key, {
        translationGroup: key,
        contentType: item.contentType.key,
        title: item.title,
        have: [item.locale],
        missing: [],
      });
    }
  }

  const gaps: GroupCoverage[] = [];
  let complete = 0;
  for (const group of groups.values()) {
    group.missing = required.filter((locale) => !group.have.includes(locale));
    group.have.sort();
    if (group.missing.length === 0) complete++;
    else gaps.push(group);
  }

  return {
    checkedAt: new Date().toISOString(),
    requiredLocales: required,
    totalGroups: groups.size,
    complete,
    incomplete: gaps.length,
    gaps,
  };
}

export default definePlugin<ContentPackSettings>({
  manifest: {
    id: "vn.zsoft.plugin.content-pack",
    name: "Z-SOFT Content Pack",
    version: "0.1.0",
    author: { name: "Z-SOFT Co., Ltd", url: "https://z-soft.com.vn" },
    engine: ">=0.1.0",
    permissions: ["content:read"],
    capabilities: ["content.audit"],
  },

  setup: async (ctx) => {
    await ctx.storage.set("installed", { at: new Date().toISOString() });
    ctx.log.info(
      `Z-SOFT Content Pack activated on "${ctx.site.name}". ` +
        `Seed the site's pages & posts from the Z-SOFT theme (Appearance → Seed demo content); ` +
        `this plugin then audits their language coverage.`,
    );
    // Kick off the first audit off the request path.
    await ctx.jobs.enqueue("audit", {});
  },

  actions: {
    // Re-audit whenever the published set changes. Cheap, and off the hot path.
    "content.published": async (event, ctx) => {
      ctx.log.info(`Content published: ${event.path} — re-auditing language coverage.`);
      await ctx.jobs.enqueue("audit", {});
    },
    "content.unpublished": async (_event, ctx) => {
      await ctx.jobs.enqueue("audit", {});
    },
  },

  jobs: {
    // The sweep: audit every published page/post and store the coverage report.
    audit: async (_payload, ctx) => {
      const report = await buildReport(ctx);
      await ctx.storage.set("audit:report", report);

      const summary =
        `Content Pack audit: ${report.complete}/${report.totalGroups} groups complete ` +
        `across [${report.requiredLocales.join(", ")}], ${report.incomplete} with gaps.`;

      if (report.incomplete > 0 && ctx.settings.warnOnGaps !== false) {
        const sample = report.gaps
          .slice(0, 5)
          .map((g) => `"${g.title}" missing ${g.missing.join("/")}`)
          .join("; ");
        ctx.log.warn(`${summary} ${sample}`);
      } else {
        ctx.log.info(summary);
      }
    },
  },

  calls: {
    // On-demand coverage report, reachable by the `content.audit` capability.
    // Returns the last stored report, or computes a fresh one if none exists yet.
    report: async (_payload, ctx) => {
      const cached = await ctx.storage.get<CoverageReport>("audit:report");
      if (cached) return cached;
      const report = await buildReport(ctx);
      await ctx.storage.set("audit:report", report);
      return report;
    },
  },
});
