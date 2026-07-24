import { config as loadEnv } from "dotenv";
import { defineConfig, env } from "prisma/config";
import path from "node:path";

// Prisma 7 no longer reads `url` from schema.prisma; connection config lives here.
// Load the repo-root .env so a single file drives every workspace package.
loadEnv({ path: path.resolve(__dirname, "../../.env"), quiet: true });

export default defineConfig({
  schema: path.join(__dirname, "prisma", "schema.prisma"),
  migrations: {
    path: path.join(__dirname, "prisma", "migrations"),
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    // Migrations and seeds run as the OWNER role so they are not blocked by RLS.
    url: env("DATABASE_URL"),
  },
});
