import type { MediaFolderDto } from "@zcmsorg/schemas";
import { describe, expect, it } from "vitest";
import { ancestorsOf, childrenOf, folderOptions } from "../folder-tree";

/** A folder with only the fields these helpers actually read. */
function folder(id: string, parentId: string | null, name = id): MediaFolderDto {
  return { id, name, parentId, fileCount: 0, subfolderCount: 0, createdAt: "2024-01-01T00:00:00Z" };
}

//   root(null)
//   ├─ a
//   │  └─ a1
//   └─ b
const TREE = [folder("a", null), folder("a1", "a"), folder("b", null)];

describe("childrenOf", () => {
  it("returns the folders whose parent is the given id", () => {
    expect(childrenOf(TREE, "a").map((f) => f.id)).toEqual(["a1"]);
  });

  it("returns the top-level folders for a null parent", () => {
    expect(childrenOf(TREE, null).map((f) => f.id)).toEqual(["a", "b"]);
  });

  it("returns nothing for a folder that has no children", () => {
    expect(childrenOf(TREE, "a1")).toEqual([]);
  });
});

describe("ancestorsOf", () => {
  it("lists the trail from the root down to, and including, the folder", () => {
    expect(ancestorsOf(TREE, "a1").map((f) => f.id)).toEqual(["a", "a1"]);
  });

  it("is empty at the root", () => {
    expect(ancestorsOf(TREE, null)).toEqual([]);
  });

  it("stops at an orphan whose parent is missing rather than looping", () => {
    // The API should never send a dangling parentId, but the breadcrumb renders
    // whatever it is handed; a missing parent must terminate the walk.
    const orphan = [folder("x", "gone")];
    expect(ancestorsOf(orphan, "x").map((f) => f.id)).toEqual(["x"]);
  });

  it("does not hang when a cycle is present in the data", () => {
    // A cycle cannot survive the API's checks, but this walk runs in a render —
    // an unbounded loop here would freeze the browser tab, so the bound is the
    // safety net being asserted.
    const cyclic = [folder("p", "q"), folder("q", "p")];
    const trail = ancestorsOf(cyclic, "p");
    expect(trail.length).toBeLessThanOrEqual(cyclic.length + 1);
  });
});

describe("folderOptions", () => {
  it("flattens the tree depth-first and indents each level", () => {
    const options = folderOptions(TREE);
    expect(options.map((o) => o.id)).toEqual(["a", "a1", "b"]);
    // a1 sits one level down, so its label is indented past its parent's. The
    // indent is a non-breaking space on purpose: a <select> collapses ordinary
    // spaces, and the whole point of the label is to read as a tree.
    const a1 = options.find((o) => o.id === "a1");
    expect(a1?.label.startsWith("  ")).toBe(true);
    expect(a1?.label.trim()).toBe("a1");
    expect(options.find((o) => o.id === "a")?.label).toBe("a");
  });

  it("drops the excluded folder and its whole subtree", () => {
    // A folder cannot be moved into itself or a descendant, so offering "a" or its
    // child "a1" as a destination while moving "a" would be offering a guaranteed
    // rejection.
    const options = folderOptions(TREE, "a");
    expect(options.map((o) => o.id)).toEqual(["b"]);
  });
});
