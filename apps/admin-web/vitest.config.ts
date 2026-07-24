import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { mergeConfig } from "vitest/config";
import { preset } from "../../vitest.shared";

export default mergeConfig(
  preset({
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    coverage: { lines: 60, functions: 60, branches: 55, statements: 60 },
    // Server components and pages are integration surface, not units.
    coverageExclude: [
      "src/app/**/page.tsx",
      "src/app/**/layout.tsx",
      "src/app/**/loading.tsx",
      "src/app/**/error.tsx",
      "src/app/**/not-found.tsx",
    ],
  }),
  {
    plugins: [react()],
    // The `@/*` path alias mirrors tsconfig.json — the source files under test
    // import through it, so the test runner has to resolve it the same way.
    resolve: {
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
  },
);
