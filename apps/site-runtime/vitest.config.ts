import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { mergeConfig } from "vitest/config";
import { preset } from "../../vitest.shared";

export default mergeConfig(
  preset({
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    coverage: { lines: 65, functions: 65, branches: 60, statements: 65 },
    coverageExclude: [
      "src/app/**/page.tsx",
      "src/app/**/layout.tsx",
      "src/app/**/not-found.tsx",
    ],
  }),
  {
    plugins: [react()],
    resolve: {
      // Mirror the "@/*" -> "./src/*" alias from tsconfig.json so the route
      // handlers under test can import "@/lib/*" the same way Next resolves it.
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
  },
);
