import { preset } from "../../vitest.shared";

// The only source file in this package is `src/main.ts`, a process entrypoint
// that the shared harness deliberately EXCLUDES from coverage (ALWAYS_EXCLUDED
// lists `**/main.ts`, because entrypoints are wiring, covered by the suites that
// boot them). That leaves the coverage denominator empty, so a line/branch floor
// here would measure nothing. The floor is therefore set to 0 — not to hide
// untested code, but because there is no in-scope code left to measure.
//
// The CLI is still tested, thoroughly: `main.test.ts` drives the real `zcms`
// binary as a subprocess (argument parsing, command dispatch, error messages,
// and a real keygen -> pack -> verify round-trip against temp dirs). That
// coverage is real behaviour coverage; it just does not register on v8's
// line counter because the code runs in a child process.
export default preset({
  testTimeout: 30_000,
  coverage: { lines: 0, functions: 0, branches: 0, statements: 0 },
});
