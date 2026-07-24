import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Compiles src/sandbox/worker.ts to src/sandbox/worker.js before any test runs.
 *
 * runner.ts resolves its worker as `path.join(__dirname, "worker.js")` and throws
 * if it is not there — deliberately, because a missing worker once made every
 * attack "pass" by failing to spawn at all. Under Vitest, __dirname is src/sandbox,
 * so the worker has to exist there for the suite to exercise the REAL isolate
 * rather than a spawn failure. This is the same compiler the build uses; the
 * output is a build artifact (gitignored), not source.
 */

const SANDBOX_DIR = path.resolve(__dirname, "../src/sandbox");
const SOURCE = path.join(SANDBOX_DIR, "worker.ts");
const OUTPUT = path.join(SANDBOX_DIR, "worker.js");
const TSC = path.resolve(__dirname, "../node_modules/.bin/tsc");

function isStale(): boolean {
  if (!fs.existsSync(OUTPUT)) return true;
  return fs.statSync(SOURCE).mtimeMs > fs.statSync(OUTPUT).mtimeMs;
}

if (isStale()) {
  execFileSync(
    TSC,
    [
      SOURCE,
      "--outDir",
      SANDBOX_DIR,
      "--module",
      "CommonJS",
      "--moduleResolution",
      "Node",
      "--target",
      "ES2022",
      "--esModuleInterop",
      "--skipLibCheck",
    ],
    { stdio: "inherit" },
  );
}

if (!fs.existsSync(OUTPUT)) {
  throw new Error(`Failed to build ${OUTPUT}; the sandbox suite cannot run without it.`);
}
