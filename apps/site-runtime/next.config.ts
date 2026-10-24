import { config as loadEnv } from "dotenv";
import type { NextConfig } from "next";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// Next only looks for .env inside the app directory. Z-CMS keeps one .env at the
// repo root so the API, the migrations and both front ends cannot disagree about
// which database or internal token they mean.
loadEnv({ path: path.resolve(import.meta.dirname, "../../.env"), quiet: true });

/**
 * The whole `cjs/` directory of react and react-dom, as globs relative to this app.
 *
 * Packaged themes are plain ESM loaded at runtime (lib/theme-loader.ts), and they
 * `import { Fragment, useState } from "react"`. React is CommonJS, so Node finds
 * those named exports by lexing `react/index.js`, which requires BOTH
 * `cjs/react.production.js` and `cjs/react.development.js` behind a NODE_ENV
 * branch — and if either file is missing, the lexer gives up and every named
 * import fails ("Named export 'Fragment' not found"). Next's tracer only follows
 * the production branch (16.4 stopped shipping the development file), so the
 * standalone image loaded no packaged theme at all and every site fell back to the
 * compiled-in default. The app never imports these files itself; themes do.
 */
function runtimeModuleIncludes(): string[] {
  const require = createRequire(import.meta.url);
  return ["react", "react-dom"].map((name) => {
    const dir = fs.realpathSync(path.dirname(require.resolve(`${name}/package.json`)));
    return `${path.relative(import.meta.dirname, dir).split(path.sep).join("/")}/cjs/**`;
  });
}

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Emit a self-contained server (.next/standalone) that bundles only the traced
  // dependencies — what the production image runs, with no pnpm or workspace
  // symlinks. The tracing root must be the repo root so the trace follows the
  // @zcmsorg/* theme packages resolved two levels up, not just this app.
  output: "standalone",
  outputFileTracingRoot: path.resolve(import.meta.dirname, "../.."),
  outputFileTracingIncludes: { "/*": runtimeModuleIncludes() },

  /**
   * Workspace packages ship raw TypeScript (their package.json "exports" point at
   * src/index.ts) rather than a build artefact, so Next must compile them itself.
   * A marketplace theme installed later would be listed here too — or loaded
   * dynamically; see lib/theme-registry.ts.
   */
  transpilePackages: ["@zcmsorg/schemas", "@zcmsorg/theme-sdk", "@zcmsorg/theme-default"],

  // Media lives in S3/MinIO and is referenced by absolute URL from block props;
  // the theme renders plain <img>, so no image domains need allow-listing here.
  poweredByHeader: false,

  // Security headers, including a per-request CSP nonce, are set in
  // src/middleware.ts — a nonce cannot be a static header.
};

export default nextConfig;
