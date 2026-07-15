import { definePlugin } from "@zcmsorg/plugin-sdk";

interface HelloWorldSettings {
  greeting: string;
  includeSiteName: boolean;
}

function greetingFor(
  settings: HelloWorldSettings,
  siteName: string,
  title: string,
): string {
  const greeting = settings.greeting || "Hello from Z-CMS";
  const suffix = settings.includeSiteName === false ? "" : ` on ${siteName}`;
  return `${greeting}${suffix}: ${title}`;
}

export default definePlugin<HelloWorldSettings>({
  manifest: {
    id: "vn.zsoft.plugin.helloworld",
    name: "HelloWorld",
    version: "0.1.0",
    author: { name: "Z-SOFT Co., Ltd" },
    engine: ">=0.1.0",
    permissions: ["content:read"],
    capabilities: ["demo.hello"],
  },

  actions: {
    "content.published": async (event, ctx) => {
      const content = await ctx.content.get(event.contentId);
      const title = content?.title ?? event.title;
      const message = greetingFor(ctx.settings, ctx.site.name, title);

      await ctx.storage.set(`hello:${event.contentId}`, {
        contentId: event.contentId,
        path: event.path,
        message,
        greetedAt: event.publishedAt,
      });

      ctx.log.info(message);
    },

    "content.deleted": async (event, ctx) => {
      await ctx.storage.delete(`hello:${event.contentId}`);
    },
  },

  setup: async (ctx) => {
    await ctx.storage.set("installed", {
      plugin: "vn.zsoft.plugin.helloworld",
      siteId: ctx.site.id,
      installedAt: new Date().toISOString(),
    });
    ctx.log.info(`HelloWorld activated on site "${ctx.site.name}".`);
  },
});
