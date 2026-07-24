import { describe, expect, it } from "vitest";
import {
  BASE,
  REQUIRED_NAMESPACES,
  STABLE_THRESHOLD,
  coverageOf,
  flatten,
  namespacesOf,
  readNamespace,
} from "../scripts/coverage";

/**
 * `scripts/coverage.ts` decides whether a language is offered to users. It is a
 * build-time script, not shipped runtime — but its pure logic is exactly the kind
 * that rots silently, so it is unit-tested here rather than only exercised by the
 * CI check. These tests do not rewrite the script; they pin its behaviour.
 *
 * This test lives in `test/` (not next to the source) because the shared harness
 * only collects `src/**` and `test/**`, and the scripts are build tooling that
 * sits outside the coverage-measured `src/` tree.
 */

describe("flatten", () => {
  it("joins nested keys with dots", () => {
    // The flat "a.b" form is what a translation key looks like, and the whole
    // coverage comparison is done in it. A change here silently mis-counts every
    // locale.
    expect([...flatten({ a: { b: "x" } })]).toEqual([["a.b", "x"]]);
  });

  it("keeps a top-level key as-is", () => {
    expect([...flatten({ save: "Save" })]).toEqual([["save", "Save"]]);
  });

  it("flattens several levels deep", () => {
    expect(flatten({ a: { b: { c: "x" } } }).get("a.b.c")).toBe("x");
  });

  it("treats an array as a leaf value rather than recursing into its indices", () => {
    // A translated string is never an array, but if one slipped in, recursing
    // would invent keys like "a.0" and compare against nothing.
    const flat = flatten({ a: ["x", "y"] });

    expect(flat.has("a")).toBe(true);
    expect(flat.has("a.0")).toBe(false);
  });

  it("returns an empty map for an empty object", () => {
    expect(flatten({}).size).toBe(0);
  });
});

describe("namespacesOf", () => {
  it("lists the base locale's namespaces, sorted, without the .json extension", () => {
    // The comparison in `count` reads keys namespace by namespace off this list;
    // an unsorted or extension-carrying entry would look for files that are not there.
    const namespaces = namespacesOf(BASE);

    expect(namespaces).toContain("common");
    expect(namespaces.every((ns) => !ns.endsWith(".json"))).toBe(true);
    expect([...namespaces]).toEqual([...namespaces].sort());
  });
});

describe("readNamespace", () => {
  it("reads a real namespace file as a parsed object", () => {
    const common = readNamespace(BASE, "common");

    expect(typeof common).toBe("object");
    expect(Object.keys(common).length).toBeGreaterThan(0);
  });

  it("returns an empty object for a namespace a locale has not translated", () => {
    // The fallback depends on this: a missing file is "nothing translated here",
    // not a crash. If it threw, one untranslated namespace would fail the build.
    expect(readNamespace(BASE, "does-not-exist")).toEqual({});
  });
});

describe("coverageOf", () => {
  it("reports the base locale as fully covered and stable", () => {
    // English is measured against itself; anything other than 100% would mean the
    // gate's own baseline is broken.
    const coverage = coverageOf(BASE);

    expect(coverage.status).toBe("stable");
    expect(coverage.required.percent).toBe(100);
    expect(coverage.overall.percent).toBe(100);
  });

  it("counts a fully-translated locale as stable", () => {
    // `vi` ships complete in this repo. If coverage of a complete locale ever
    // computed below the threshold, a shipped language would vanish from the
    // switcher on the next deploy.
    const coverage = coverageOf("vi");

    expect(coverage.required.percent).toBeGreaterThanOrEqual(STABLE_THRESHOLD * 100);
    expect(coverage.status).toBe("stable");
  });

  it("measures the required set against exactly REQUIRED_NAMESPACES", () => {
    // The gate reads `required`, not `overall`. Its denominator must be the keys
    // of the required namespaces and nothing else.
    let expectedTotal = 0;
    for (const ns of REQUIRED_NAMESPACES) {
      for (const value of flatten(readNamespace(BASE, ns)).values()) {
        if (typeof value === "string") expectedTotal++;
      }
    }

    expect(coverageOf("vi").required.total).toBe(expectedTotal);
  });
});
