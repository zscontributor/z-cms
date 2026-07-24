import { defineConfig, type ViteUserConfig } from "vitest/config";

/**
 * The one place the test harness is configured.
 *
 * Every package's `vitest.config.ts` is three lines that call into this file, so
 * a contributor never chooses a reporter, a coverage provider, or a timeout —
 * and a reviewer never has to check whether they chose well. If a setting needs
 * to change, it changes here, once, for the whole platform.
 *
 * See docs/testing.md for the conventions this file enforces.
 */

/** Files that are shipped but are not logic anyone can meaningfully unit test. */
const ALWAYS_EXCLUDED = [
  "**/node_modules/**",
  "**/dist/**",
  "**/.next/**",
  "**/generated/**", // Prisma's output — testing it tests Prisma.
  "**/*.config.*",
  "**/*.d.ts",
  "**/index.ts", // Barrel files: re-exports only, no branches.
  "**/verify-*.ts", // The attack suites. They are executables, not units.
  "**/main.ts", // Process entrypoints: wiring, covered by the suites that boot them.
];

/**
 * Excluded from COVERAGE only (not from the run): the test files themselves. A
 * test file's lines all execute, so leaving it in the denominator would flatter
 * the score. The code a test exercises is what we measure.
 */
const COVERAGE_ONLY_EXCLUDED = ["**/test/**", "**/*.test.{ts,tsx}"];

export interface PresetOptions {
  /**
   * Per-package coverage floor. A package may raise its own floor above the
   * default but is not allowed to silently sit below it — CI reads these.
   */
  coverage?: { lines?: number; functions?: number; branches?: number; statements?: number };
  /** Extra glob patterns to keep out of the coverage denominator. */
  coverageExclude?: string[];
  /** Vitest environment. `node` for everything that is not a React tree. */
  environment?: "node" | "jsdom";
  /** Files run before each test file (e.g. jest-dom matchers). */
  setupFiles?: string[];
  /** Seconds a single test may take before it is considered hung. */
  testTimeout?: number;
}

/**
 * The floor, not the target. 80% of the lines of a security-critical package
 * being executed by a test is the minimum bar for calling it tested; the suites
 * in this repo aim well past it.
 */
const DEFAULT_COVERAGE = {
  lines: 80,
  functions: 80,
  branches: 75,
  statements: 80,
};

export function preset(options: PresetOptions = {}): ViteUserConfig {
  return defineConfig({
    test: {
      // No `describe`/`it` imports to forget, and no lint rule needed to enforce it.
      globals: true,
      environment: options.environment ?? "node",
      setupFiles: options.setupFiles,

      // Convention: tests live next to the code they test, named *.test.ts.
      // A contributor never has to ask where a test goes — it goes beside the file.
      include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"],
      exclude: ALWAYS_EXCLUDED,

      // A unit test that takes five seconds is not a unit test; it is a hung one.
      // The package suites that shell out to real crypto/tar get more, explicitly.
      testTimeout: options.testTimeout ?? 5_000,
      hookTimeout: 10_000,

      // A test that passes only because it ran after another test is a test that
      // will fail in CI on a different machine. Isolate, and let it cost what it costs.
      isolate: true,
      restoreMocks: true,
      unstubEnvs: true,
      unstubGlobals: true,

      reporters: process.env.CI ? ["default", "junit"] : ["default"],
      outputFile: { junit: "./test-results.junit.xml" },

      coverage: {
        provider: "v8",
        // json-summary is what the CI badge and the coverage table read.
        reporter: ["text", "json-summary", "json", "lcov"],
        reportsDirectory: "./coverage",
        include: ["src/**/*.{ts,tsx}"],
        exclude: [
          ...ALWAYS_EXCLUDED,
          ...COVERAGE_ONLY_EXCLUDED,
          ...(options.coverageExclude ?? []),
        ],
        // Files with no test at all still count against the score. Without this,
        // deleting a test file *raises* coverage, which is exactly backwards.
        all: true,
        thresholds: { ...DEFAULT_COVERAGE, ...options.coverage },
      },
    },
  });
}
