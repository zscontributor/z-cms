import { mergeConfig } from "vitest/config";
import { preset } from "../../vitest.shared";

// The isolate is REAL here — `isolated-vm` is never mocked. A sandbox that holds
// against a fake isolate proves nothing about the one that runs strangers' code.
//
// Two consequences for the harness:
//   - `pool: "forks"` — the suite spawns worker threads that load the native
//     isolated-vm binding; a forked child process is the pool that tolerates that.
//   - the setup file builds src/sandbox/worker.js, because runner.ts resolves its
//     worker relative to __dirname and refuses (loudly, by design) to run from
//     TypeScript sources.
export default mergeConfig(
  preset({
    testTimeout: 30_000,
    setupFiles: ["./test/build-worker.ts"],
    coverage: { lines: 75, functions: 75, branches: 70, statements: 75 },
    // worker.ts is compiled to worker.js and executed in a SEPARATE worker thread,
    // out of this process — v8 coverage here physically cannot attribute its lines,
    // even though runner.test.ts drives every branch of it through the REAL isolate
    // (benign run, memory kill, timeout kill, every escape, the ctx allow-list). It
    // is an out-of-process entrypoint, the same category the shared preset already
    // excludes (verify-*.ts, main.ts); counting it would report 0% for code that is
    // in fact the most heavily attacked in the suite.
    coverageExclude: ["src/sandbox/worker.ts"],
  }),
  {
    test: {
      // The sandbox suite launches real worker threads under `isolated-vm`.
      // In CI, letting Vitest fan those out across multiple workers increases the
      // odds of a native crash. Run one fork and disable file-level parallelism so
      // the attack harness stays deterministic and the host process remains stable.
      pool: "forks",
      fileParallelism: false,
      maxWorkers: 1,
      minWorkers: 1,
    },
  },
);
