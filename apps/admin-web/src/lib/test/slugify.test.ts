import { describe, expect, it } from "vitest";
import { isValidSlug, slugify } from "../slugify";

describe("slugify", () => {
  it("strips Vietnamese tone marks down to ASCII", () => {
    // The reason this module exists: an editor types a Vietnamese title and the
    // URL still has to be something a browser and a filesystem can carry.
    expect(slugify("Tiếng Việt")).toBe("tieng-viet");
  });

  it("maps the stroked đ/Đ, which NFD leaves behind", () => {
    // "đ" is not a base letter plus a combining mark, so the NFD strip misses it —
    // without the explicit map "Đà Nẵng" would slug to "-a-nang".
    expect(slugify("Đà Nẵng")).toBe("da-nang");
  });

  it("collapses runs of separators into a single dash", () => {
    expect(slugify("Hello   ---  World")).toBe("hello-world");
  });

  it("trims leading and trailing dashes", () => {
    expect(slugify("  !!! Hello !!!  ")).toBe("hello");
  });

  it("returns an empty string for input with no sluggable characters", () => {
    // The homepage slug is the empty string; punctuation-only input must land
    // there rather than on a lone dash.
    expect(slugify("@#$%^&*()")).toBe("");
    expect(slugify("")).toBe("");
  });

  it("caps the slug at 120 characters without a trailing dash", () => {
    const slug = slugify("a".repeat(200));
    expect(slug.length).toBeLessThanOrEqual(120);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("cannot let a path-traversal title produce a slug with a slash or dot", () => {
    // A slug flows into a URL and, downstream, a file path. If "../../etc" could
    // keep its slashes or dots, a title would become a traversal primitive.
    const slug = slugify("../../etc/passwd");
    expect(slug).not.toContain("/");
    expect(slug).not.toContain(".");
    expect(slug).toBe("etc-passwd");
  });

  it("cannot let an HTML-injection title keep its angle brackets", () => {
    // The slug is reflected in links and breadcrumbs; a "<" surviving here would
    // be the first half of stored XSS.
    const slug = slugify("<script>alert(1)</script>");
    expect(slug).not.toContain("<");
    expect(slug).not.toContain(">");
  });
});

describe("isValidSlug", () => {
  it("accepts the empty slug, which is the homepage", () => {
    expect(isValidSlug("")).toBe(true);
  });

  it("accepts lowercase hyphen-separated words", () => {
    expect(isValidSlug("about-us")).toBe(true);
  });

  it("rejects a slug with uppercase, spaces, or a leading or doubled dash", () => {
    expect(isValidSlug("About")).toBe(false);
    expect(isValidSlug("a b")).toBe(false);
    expect(isValidSlug("-about")).toBe(false);
    expect(isValidSlug("about--us")).toBe(false);
  });

  it("rejects a slug carrying a slash", () => {
    expect(isValidSlug("a/b")).toBe(false);
  });
});
