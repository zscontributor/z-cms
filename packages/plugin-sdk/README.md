# @zcmsorg/plugin-sdk

The contract for writing a [Z-CMS](https://z-cms.org) plugin: manifest, permissions, typed actions and filters.

A Z-CMS plugin runs inside an isolated sandbox, and this SDK is the only module that exists in there. No filesystem, no network client, no environment variables, no database handle — not out of politeness, but because the sandbox does not provide them and the publish-time scanner rejects a package that reaches for them. Everything the platform grants arrives as `ctx`.

## Install

You normally do not install this by hand — scaffold a plugin instead, and it comes wired up:

```sh
npm i -g @zcmsorg/cli
zcms init my-plugin --kind plugin
```

To add it to an existing package:

```sh
npm i @zcmsorg/plugin-sdk
```

## Usage

The manifest lives in `plugin.json` — that file is what the packer signs and what the admin's consent screen renders, so declaring it twice would be a lie that still compiled.

```ts
import { definePlugin, type PluginManifest } from "@zcmsorg/plugin-sdk";
import manifestJson from "../plugin.json";

const manifest = manifestJson as unknown as PluginManifest;

export default definePlugin({
  manifest,

  // Value transformers, run in the render path under a hard timeout.
  filters: {
    "seo.title": (title, _context, ctx) => `${title} — ${ctx.settings.suffix}`,
  },

  // Fire-and-forget handlers. The CMS does not wait for these.
  actions: {
    "content.published": async (event, ctx) => {
      ctx.log.info(`published: ${event.slug}`);
    },
  },
});
```

A plugin declares every capability it wants in the manifest's `permissions`. The host grants exactly those and nothing more.

## Docs

- [Writing plugins](https://github.com/zscontributor/z-cms/blob/main/docs/plugins.md)
- [Packaging, signing and distribution](https://github.com/zscontributor/z-cms/blob/main/docs/distribution.md)
- [Sandbox and security model](https://github.com/zscontributor/z-cms/blob/main/docs/security.md)

## License

MIT © Z-SOFT Co., Ltd.
