import { describe, expect, it } from "vitest";
import { compareSemver, maxSemver, parseSemver, validateVersion } from "../semver";

/**
 * This module exists to answer one question — "is this version newer than that
 * one?" — and the marketplace now refuses an upload when the answer is no. So the
 * cases that matter are the ones where the naive answer is wrong: pre-releases,
 * numeric identifiers that must not sort like text, and build metadata that must
 * not count at all.
 */

describe("validateVersion — format", () => {
  it.each(["1.0.0", "0.1.0", "10.20.30", "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-rc.1+build.5"])(
    "accepts %s",
    (v) => {
      expect(validateVersion(v)).toBeNull();
    },
  );

  it.each([
    ["empty", ""],
    ["not a version", "banana"],
    ["two segments", "1.0"],
    ["a v prefix", "v1.0.0"],
    ["a leading zero", "01.0.0"],
    ["trailing text", "1.0.0.0"],
  ])("refuses %s", (_label, v) => {
    expect(validateVersion(v)).not.toBeNull();
  });

  it("refuses a non-string", () => {
    expect(validateVersion(42 as unknown as string)).toMatch(/required/);
  });
});

describe("compareSemver — precedence", () => {
  it("orders by major, minor, patch", () => {
    expect(compareSemver("2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareSemver("1.2.0", "1.1.9")).toBeGreaterThan(0);
    expect(compareSemver("1.1.2", "1.1.1")).toBeGreaterThan(0);
    expect(compareSemver("1.1.1", "1.1.1")).toBe(0);
  });

  /** A pre-release is not a release; it sorts BELOW the version it precedes. */
  it("ranks a pre-release below its release", () => {
    expect(compareSemver("1.0.0-alpha", "1.0.0")).toBeLessThan(0);
    expect(compareSemver("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0);
  });

  /** "10" is greater than "2" as a number, less than "2" as text. It is a number. */
  it("compares numeric pre-release identifiers numerically", () => {
    expect(compareSemver("1.0.0-alpha.10", "1.0.0-alpha.2")).toBeGreaterThan(0);
  });

  it("ranks numeric pre-release identifiers below alphanumeric ones", () => {
    expect(compareSemver("1.0.0-1", "1.0.0-alpha")).toBeLessThan(0);
  });

  it("ranks more pre-release identifiers above fewer, all else equal", () => {
    expect(compareSemver("1.0.0-alpha.1", "1.0.0-alpha")).toBeGreaterThan(0);
  });

  /** Build metadata is invisible to precedence. */
  it("ignores build metadata", () => {
    expect(compareSemver("1.0.0+build.1", "1.0.0+build.999")).toBe(0);
    expect(compareSemver("1.0.0+anything", "1.0.0")).toBe(0);
  });

  it("throws on garbage rather than lying with a 0", () => {
    expect(() => compareSemver("banana", "1.0.0")).toThrow(/semantic version/);
  });
});

describe("maxSemver", () => {
  it("finds the highest by precedence, not by position or length", () => {
    expect(maxSemver(["1.0.0", "1.2.0", "1.1.5"])).toBe("1.2.0");
    expect(maxSemver(["2.0.0", "10.0.0", "1.0.0"])).toBe("10.0.0");
  });

  it("treats a release as higher than its pre-releases", () => {
    expect(maxSemver(["1.0.0-rc.1", "1.0.0-rc.2", "1.0.0"])).toBe("1.0.0");
  });

  it("is null for an empty list", () => {
    expect(maxSemver([])).toBeNull();
  });

  /** One unparseable legacy row must not blind it to the valid ones. */
  it("skips unparseable entries", () => {
    expect(maxSemver(["banana", "1.0.0", "garbage"])).toBe("1.0.0");
    expect(maxSemver(["banana"])).toBeNull();
  });
});

describe("parseSemver", () => {
  it("splits the pieces", () => {
    expect(parseSemver("1.2.3-beta.4+build")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: ["beta", 4],
    });
  });

  it("is null for nonsense", () => {
    expect(parseSemver("nope")).toBeNull();
  });
});
