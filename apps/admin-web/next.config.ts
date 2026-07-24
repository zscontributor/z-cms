import { config as loadEnv } from "dotenv";
import path from "node:path";

// Next only reads .env from the app dir; Z-CMS keeps one at the repo root so
// the API, migrations and both front ends cannot disagree about their config.
loadEnv({ path: path.resolve(import.meta.dirname, "../../.env"), quiet: true });

import type { NextConfig } from "next";

const adminBasePath =
  process.env.ADMIN_BASE_PATH ?? (process.env.NODE_ENV === "production" ? "/admin" : "");

/**
 * @zcmsorg/schemas is published from source (its package `exports` points at
 * `src/index.ts`), so Next has to compile it rather than treat it as a
 * prebuilt dependency.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  ...(adminBasePath ? { basePath: adminBasePath } : {}),
  transpilePackages: ["@zcmsorg/schemas"],
  typedRoutes: false,

  // Emit a self-contained server (.next/standalone) that bundles only the traced
  // dependencies. It is what the production image runs — no pnpm, no workspace
  // symlinks, no dev toolchain. In a monorepo the tracing root has to be the repo
  // root, otherwise Next traces from apps/admin-web and misses @zcmsorg/* packages
  // resolved two levels up.
  output: "standalone",
  outputFileTracingRoot: path.resolve(import.meta.dirname, "../.."),
  images: {
    // Media comes from S3/MinIO in dev; allow any host we are pointed at.
    remotePatterns: [
      { protocol: "http", hostname: "localhost" },
      { protocol: "https", hostname: "**" },
    ],
  },
  experimental: {
    // Server Actions receive multipart uploads for the media library.
    serverActions: {
      bodySizeLimit: "25mb",
    },
  },
};

export default nextConfig;
