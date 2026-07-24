import { t as translator } from "@zcmsorg/i18n";
import {
  COLLECTION_MAX_LIMIT,
  COLLECTION_SORTS,
  CORE_BLOCK_TYPES,
  clampCollectionLimit,
} from "@zcmsorg/schemas";
import { describe, expect, it } from "vitest";
import {
  BLOCK_SPECS,
  blockLabel,
  createBlock,
  getBlockSpec,
  isCoreBlockType,
  newBlockId,
} from "../block-registry";

const t = translator("en");

/** The translator echoes a key it cannot resolve, so a key IS its own failure mode. */
function resolves(key: string): boolean {
  return t(key) !== key;
}

describe("getBlockSpec", () => {
  it("returns the spec for a known core block type", () => {
    expect(getBlockSpec("core/hero")?.type).toBe("core/hero");
  });

  it("returns undefined for a type not in the registry", () => {
    // An unknown block round-trips as read-only JSON; the caller relies on
    // `undefined` here to make that decision, not on a thrown error.
    expect(getBlockSpec("acme/carousel")).toBeUndefined();
  });

  it("has a spec for every core block type the schema declares", () => {
    for (const type of CORE_BLOCK_TYPES) {
      expect(getBlockSpec(type), `missing spec for ${type}`).toBeDefined();
    }
  });
});

describe("isCoreBlockType", () => {
  it("accepts a declared core type and rejects a foreign one", () => {
    expect(isCoreBlockType("core/richtext")).toBe(true);
    expect(isCoreBlockType("acme/carousel")).toBe(false);
  });
});

describe("blockLabel", () => {
  it("translates a known block's label", () => {
    const spec = BLOCK_SPECS[0]!;
    expect(blockLabel(spec.type, t)).toBe(t(spec.labelKey));
  });

  it("falls back to the raw type for an unknown block", () => {
    // A third-party block still needs *a* name in the outline; the type string is
    // the honest one rather than a blank.
    expect(blockLabel("acme/carousel", t)).toBe("acme/carousel");
  });
});

describe("newBlockId", () => {
  it("mints ids that do not collide across a burst of calls", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newBlockId()));
    expect(ids.size).toBe(200);
  });

  it("prefixes the id so it is recognisable in a document", () => {
    expect(newBlockId()).toMatch(/^blk_/);
  });
});

describe("createBlock", () => {
  it("builds a block with an id, its type, and the spec's default props", () => {
    const block = createBlock("core/hero", t);
    expect(block.type).toBe("core/hero");
    expect(block.id).toMatch(/^blk_/);
    // The hero's heading default is authored in the editor's language at insert.
    expect(block.props.heading).toBe(t("content.blocks.defaults.heroHeading"));
    expect(block.props.align).toBe("center");
  });

  it("gives each created block its own id", () => {
    expect(createBlock("core/cta", t).id).not.toBe(createBlock("core/cta", t).id);
  });
});

describe("catalogue keys", () => {
  // Every string in the registry is a key, and an unresolved key renders as the
  // raw key ("content.blocks.props.limit") in the editor — visible only to whoever
  // is running the admin in that language, which is rarely the person who added it.
  it("resolves every key a spec declares", () => {
    for (const spec of BLOCK_SPECS) {
      expect(resolves(spec.labelKey), `${spec.type}: ${spec.labelKey}`).toBe(true);
      expect(resolves(spec.descriptionKey), `${spec.type}: ${spec.descriptionKey}`).toBe(true);

      for (const prop of spec.props) {
        expect(resolves(prop.labelKey), `${spec.type}.${prop.key}: ${prop.labelKey}`).toBe(true);
        for (const key of [prop.placeholderKey, prop.hintKey, prop.itemLabelKey]) {
          if (key) expect(resolves(key), `${spec.type}.${prop.key}: ${key}`).toBe(true);
        }
        for (const option of prop.options ?? []) {
          expect(resolves(option.labelKey), `${spec.type}.${prop.key}: ${option.labelKey}`).toBe(
            true,
          );
        }
        for (const field of prop.itemFields ?? []) {
          expect(resolves(field.labelKey), `${spec.type}.${prop.key}: ${field.labelKey}`).toBe(
            true,
          );
        }
      }
    }
  });
});

describe("core/content-list", () => {
  const spec = getBlockSpec("core/content-list")!;
  const prop = (key: string) => spec.props.find((entry) => entry.key === key);

  it("picks the content type with a select, not a free-text box", () => {
    // Typing "posts" where the site says "post" is a list that is silently empty
    // forever. The control resolves against the site's real types instead.
    expect(prop("contentType")?.kind).toBe("contentType");
  });

  it("bounds the limit by the cap the server enforces", () => {
    // If the control's max and COLLECTION_MAX_LIMIT ever disagree, the editor can
    // ask for a number the server will quietly cut down to something else.
    const limit = prop("limit");
    expect(limit?.kind).toBe("number");
    expect(limit?.min).toBe(1);
    expect(limit?.max).toBe(COLLECTION_MAX_LIMIT);
  });

  it("offers exactly the sorts the schema implements", () => {
    // A sort the select offers but the resolver does not implement falls back to
    // "newest" server-side — the editor picks an order and gets a different one.
    expect(prop("sort")?.options?.map((option) => option.value)).toEqual([...COLLECTION_SORTS]);
  });

  it("offers list and grid as the layout hint", () => {
    expect(prop("layout")?.options?.map((option) => option.value)).toEqual(["list", "grid"]);
  });

  it("has no control for items, which only the server may write", () => {
    // `items` is overwritten on every render. A control for it would let an author
    // put rows on a page that the query never returned.
    expect(prop("items")).toBeUndefined();
  });

  it("defaults to a query, and never to resolved rows", () => {
    const block = createBlock("core/content-list", t);

    expect(block.props).toEqual({
      contentType: "",
      limit: 6,
      sort: "newest",
      layout: "list",
      heading: "",
    });
    // No content type is guessed: a default of "post" on a site with no such type
    // is the silently-empty list this block exists to make impossible.
    expect(block.props.contentType).toBe("");
    expect(block.props).not.toHaveProperty("items");
    // The starting limit survives the server's own clamp unchanged.
    expect(clampCollectionLimit(block.props.limit)).toBe(block.props.limit);
  });
});
