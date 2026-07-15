import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(process.cwd(), "../..");

function readRepo(file: string): string {
  return fs.readFileSync(path.join(repoRoot, file), "utf8");
}

describe("production theme packaging", () => {
  it("uses the built-in themes shipped inside the site-runtime image", () => {
    const dockerfile = readRepo("infrastructure/docker/Dockerfile");
    const compose = readRepo("infrastructure/docker/docker-compose.prod.yml");

    expect(dockerfile).toContain("COPY --from=builtin-themes /builtin/themes ./themes");

    const siteRuntime = compose.slice(
      compose.indexOf("  site-runtime:"),
      compose.indexOf("  plugin-runtime:"),
    );

    // The image already carries signed built-in themes under /app/themes. Mounting
    // a host directory over THEME_DIR can hide the exact .zcms versions the DB has
    // registered, making active built-ins fall back to the compiled-in default.
    expect(siteRuntime).not.toContain("THEME_DIR:");
    expect(siteRuntime).not.toContain(":/themes:ro");
  });
});
