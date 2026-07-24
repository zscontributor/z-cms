import { config as loadEnv } from "dotenv";
import type { NextConfig } from "next";
import path from "node:path";

// Next only looks for .env inside the app directory. Z-CMS keeps one .env at the
// repo root so the API, the migrations and both front ends cannot disagree about
// which database or internal token they mean.
loadEnv({ path: path.resolve(import.meta.dirname, "../../.env"), quiet: true });

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Emit a self-contained server (.next/standalone) that bundles only the traced
  // dependencies — what the production image runs, with no pnpm or workspace
  // symlinks. The tracing root must be the repo root so the trace follows the
  // @zcmsorg/* theme packages resolved two levels up, not just this app.
  output: "standalone",
  outputFileTracingRoot: path.resolve(import.meta.dirname, "../.."),

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
