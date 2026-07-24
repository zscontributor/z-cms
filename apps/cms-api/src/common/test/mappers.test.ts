import { describe, expect, it } from "vitest";
import {
  contentPath,
  toContentDto,
  toContentTypeDto,
  toMediaDto,
  toMediaFolderDto,
  toMenuDto,
  toSiteDto,
} from "../mappers";

/**
 * These mappers are the wall between a database row and what leaves the API.
 * A branch that goes wrong here either drops a field a client needs or, worse,
 * lets a column that should never be public ride out on the row.
 */

const CONTENT_TYPE = { id: "ct1", key: "post", name: "Post", routePrefix: "blog" };

function contentRow(over: Partial<Parameters<typeof toContentDto>[0]> = {}) {
  return {
    id: "c1",
    siteId: "s1",
    locale: "en",
    translationGroupId: "g1",
    title: "Hello",
    slug: "hello",
    excerpt: null,
    data: null,
    blocks: null,
    seo: null,
    status: "PUBLISHED",
    publishedAt: new Date("2024-01-02T03:04:05.000Z"),
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: new Date("2024-01-03T00:00:00.000Z"),
    contentType: CONTENT_TYPE,
    author: { id: "u1", name: "Ann" },
    ...over,
  };
}

describe("contentPath", () => {
  it("joins a route prefix and a slug into a path", () => {
    expect(contentPath("blog", "hello")).toBe("/blog/hello");
  });

  it("treats an empty prefix as a top-level slug", () => {
    expect(contentPath("", "about")).toBe("/about");
  });

  it("maps the empty slug under a prefix to the archive root", () => {
    expect(contentPath("blog", "")).toBe("/blog");
  });

  it("maps an empty prefix and empty slug to the site root", () => {
    // The homepage. Both empty must resolve to "/", not to "" — an empty href is
    // a link to the current page, which is not what a homepage link means.
    expect(contentPath("", "")).toBe("/");
  });
});

describe("toContentDto", () => {
  it("derives the public path from the content type's route prefix", () => {
    expect(toContentDto(contentRow()).path).toBe("/blog/hello");
  });

  it("substitutes empty objects and arrays for null json columns", () => {
    // A theme iterates blocks and reads data.*; a null here would throw in the
    // renderer rather than degrade to an empty page.
    const dto = toContentDto(contentRow({ data: null, blocks: null, seo: null }));

    expect(dto.data).toEqual({});
    expect(dto.blocks).toEqual([]);
    expect(dto.seo).toEqual({});
  });

  it("serialises dates to ISO strings", () => {
    const dto = toContentDto(contentRow());

    expect(dto.createdAt).toBe("2024-01-01T00:00:00.000Z");
    expect(dto.publishedAt).toBe("2024-01-02T03:04:05.000Z");
  });

  it("reports a null publishedAt for content that was never published", () => {
    expect(toContentDto(contentRow({ publishedAt: null })).publishedAt).toBeNull();
  });

  it("carries a null author rather than inventing one", () => {
    // Authors are deleted with onDelete: SetNull; the row survives authorless.
    expect(toContentDto(contentRow({ author: null })).author).toBeNull();
  });

  it("does not expose the content type's route prefix as a public field", () => {
    // routePrefix is routing internals; the DTO exposes the resolved path instead.
    const dto = toContentDto(contentRow());

    expect(dto.contentType).not.toHaveProperty("routePrefix");
  });
});

describe("toContentTypeDto", () => {
  it("defaults a null fields column to an empty array", () => {
    const dto = toContentTypeDto({
      id: "ct1",
      key: "post",
      name: "Post",
      pluralName: "Posts",
      description: null,
      isSingleton: false,
      isRoutable: true,
      routePrefix: "blog",
      hasBlocks: true,
      icon: null,
      fields: null,
    });

    expect(dto.fields).toEqual([]);
  });
});

describe("toSiteDto", () => {
  const base = {
    id: "s1",
    slug: "main",
    name: "Main",
    status: "PUBLISHED",
    defaultLocale: "en",
    locales: ["en", "vi"],
    settings: { brand: { primaryColor: "#123456", logo: "/uploads/logo.png" } },
    domains: [{ id: "d1", hostname: "example.com", isPrimary: true }],
  };

  it("surfaces the ACTIVE theme, ignoring inactive ones", () => {
    const dto = toSiteDto({
      ...base,
      themes: [
        { status: "INACTIVE", theme: { key: "old", name: "Old" }, version: { version: "1.0.0" } },
        { status: "ACTIVE", theme: { key: "corp", name: "Corporate" }, version: { version: "2.0.0" } },
      ],
    });

    expect(dto.activeTheme).toEqual({ key: "corp", name: "Corporate", version: "2.0.0" });
  });

  it("reports a null active theme when none is active", () => {
    const dto = toSiteDto({ ...base, themes: [] });

    expect(dto.activeTheme).toBeNull();
  });
});

describe("toMenuDto", () => {
  it("nests items under their parents and orders each level", () => {
    const dto = toMenuDto({
      key: "main",
      name: "Main",
      items: [
        { id: "b", label: "B", url: "/b", target: "_self", order: 2, parentId: null },
        { id: "a", label: "A", url: "/a", target: "_self", order: 1, parentId: null },
        { id: "a1", label: "A1", url: "/a/1", target: "_self", order: 1, parentId: "a" },
      ],
    });

    expect(dto.items.map((i) => i.label)).toEqual(["A", "B"]);
    expect(dto.items[0]!.children.map((i) => i.label)).toEqual(["A1"]);
  });
});

describe("toMediaDto", () => {
  const row = {
    id: "m1",
    storageKey: "sites/s1/abc.png",
    filename: "photo.png",
    mimeType: "image/png",
    size: 1234,
    width: 800,
    height: 600,
    alt: null,
    folderId: null,
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
  };

  it("builds the public url from the base and the storage key", () => {
    expect(toMediaDto(row, "https://cdn.example.com").url).toBe(
      "https://cdn.example.com/sites/s1/abc.png",
    );
  });

  it("does not double the slash when the base url ends in one", () => {
    expect(toMediaDto(row, "https://cdn.example.com/").url).toBe(
      "https://cdn.example.com/sites/s1/abc.png",
    );
  });

  it("does not leak the raw storage key as its own field", () => {
    // The key is an implementation detail of the bucket layout; only the URL is public.
    expect(toMediaDto(row, "https://cdn.example.com")).not.toHaveProperty("storageKey");
  });
});

describe("toMediaFolderDto", () => {
  it("flattens the prisma _count into file and subfolder counts", () => {
    const dto = toMediaFolderDto({
      id: "f1",
      name: "Photos",
      parentId: null,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      _count: { media: 5, children: 2 },
    });

    expect(dto.fileCount).toBe(5);
    expect(dto.subfolderCount).toBe(2);
  });
});
