import { preset } from "../../vitest.shared";

// `node`: nothing in this package is a React tree. `src/client.ts` is an
// entrypoint that re-exports the translator and the locale list — the browser
// boundary it enforces is a module-graph one, not a DOM one.
export default preset({
  coverage: { lines: 85, functions: 85, branches: 80, statements: 85 },
});
