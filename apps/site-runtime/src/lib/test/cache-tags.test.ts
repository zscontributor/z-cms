import { describe, expect, it } from "vitest";
import {
  normaliseHostname,
  normalisePath,
  pageTag,
  renderTags,
  siteTag,
} from "../cache-tags";

/**
 * Cache tags are the isolation boundary between sites that share one runtime and
 * one Next data cache. If two different hostnames ever mint the same tag for the
 * same content id, purging one site drops (or, far worse, could serve) another
 * site's cached page. So the first thing these tests prove is that the hostname
 * is always part of the tag, and that no two distinct hosts collide.
 */

describe("siteTag", () => {
  it("namespaces the tag by hostname", () => {
    expect(siteTag("a.example")).toBe("site:a.example");
  });

  it("never produces the same tag for two different hostnames", () => {
    // The collision this whole scheme exists to prevent.
    expect(siteTag("a.example")).not.toBe(siteTag("b.example"));
  });

  it("is case- and whitespace-insensitive so one host cannot masquerade as two", () => {
    expect(siteTag("  A.Example  ")).toBe(siteTag("a.example"));
  });
});

describe("pageTag", () => {
  it("namespaces the tag by both hostname and path", () => {
    expect(pageTag("a.example", "/blog")).toBe("page:a.example:/blog");
  });

  it("never collides across sites for the same path", () => {
    // Same content id, two tenants: the tags must differ.
    expect(pageTag("a.example", "/blog/hello")).not.toBe(
      pageTag("b.example", "/blog/hello"),
    );
  });

  it("never collides across paths on the same site", () => {
    expect(pageTag("a.example", "/blog")).not.toBe(pageTag("a.example", "/about"));
  });

  it("treats trailing-slash and no-slash spellings of a path as one tag", () => {
    // Otherwise a publish that purges "/blog" would leave "/blog/" stale.
    expect(pageTag("a.example", "/blog/")).toBe(pageTag("a.example", "/blog"));
  });

  it("cannot be collapsed into another site's site-level tag", () => {
    // Guard against the two builders' outputs ever overlapping.
    expect(pageTag("a.example", "/")).not.toBe(siteTag("a.example"));
  });
});

describe("renderTags", () => {
  it("returns the site tag and the page tag for a request", () => {
    expect(renderTags("a.example", "/blog")).toEqual([
      siteTag("a.example"),
      pageTag("a.example", "/blog"),
    ]);
  });

  it("carries the hostname into both tags it returns", () => {
    const [site, page] = renderTags("tenant.example", "/x");

    expect(site).toContain("tenant.example");
    expect(page).toContain("tenant.example");
  });
});

describe("normaliseHostname", () => {
  it("lowercases and trims", () => {
    expect(normaliseHostname("  Example.COM  ")).toBe("example.com");
  });

  it("keeps the port, which is part of a dev domain's identity", () => {
    expect(normaliseHostname("localhost:3000")).toBe("localhost:3000");
  });
});

describe("normalisePath", () => {
  it("adds a leading slash when missing", () => {
    expect(normalisePath("blog/x")).toBe("/blog/x");
  });

  it("collapses the empty path to the site root", () => {
    expect(normalisePath("")).toBe("/");
  });

  it("strips a single trailing slash", () => {
    expect(normalisePath("/blog/")).toBe("/blog");
  });

  it("strips repeated trailing slashes", () => {
    expect(normalisePath("/blog///")).toBe("/blog");
  });

  it("leaves the root path as a single slash", () => {
    expect(normalisePath("/")).toBe("/");
  });
});
