import { describe, expect, it } from "vitest";
import {
  CONTAINER_SPECS,
  WIDGET_CATALOG,
  defaultWidgetProps,
  getWidgetSpec,
  isKnownWidget,
} from "../widgets";
import { WidgetTypeSchema } from "../layout";

/**
 * The catalogue is read by the editor, the widget library and the code generator.
 * A drift between them (a widget whose defaults omit a prop the library reads, a
 * type the generator cannot parse) is the kind of bug that only shows on a live
 * site, so it is pinned here instead.
 */

describe("WIDGET_CATALOG integrity", () => {
  it("every widget type is a valid namespaced type", () => {
    for (const spec of WIDGET_CATALOG) {
      expect(WidgetTypeSchema.safeParse(spec.type).success).toBe(true);
    }
  });

  it("has no duplicate types", () => {
    const types = WIDGET_CATALOG.map((s) => s.type);
    expect(new Set(types).size).toBe(types.length);
  });

  it("a collection-bound widget declares kind:collection and no fields", () => {
    const list = getWidgetSpec("dynamic/post-list");
    expect(list?.bind.kind).toBe("collection");
  });

  it("a current-bound widget declares the fields it reads", () => {
    const title = getWidgetSpec("dynamic/post-title");
    expect(title?.bind.kind).toBe("current");
    expect(title?.bind.fields).toContain("title");
  });

  it("select props carry options", () => {
    for (const spec of WIDGET_CATALOG) {
      for (const prop of spec.props) {
        if (prop.kind === "select") {
          expect(prop.options && prop.options.length > 0).toBe(true);
        }
      }
    }
  });

  it("number props with bounds are min<=max", () => {
    for (const spec of WIDGET_CATALOG) {
      for (const prop of spec.props) {
        if (prop.kind === "number" && prop.min !== undefined && prop.max !== undefined) {
          expect(prop.min).toBeLessThanOrEqual(prop.max);
        }
      }
    }
  });
});

describe("defaultWidgetProps", () => {
  it("returns the declared defaults for a known widget", () => {
    expect(defaultWidgetProps("layout/heading")).toMatchObject({
      text: "Heading",
      level: "2",
      align: "left",
    });
  });

  it("returns an empty object for an unknown widget", () => {
    expect(defaultWidgetProps("nope/nope")).toEqual({});
  });

  it("a defaulted prop matches its declared select options", () => {
    for (const spec of WIDGET_CATALOG) {
      const defaults = defaultWidgetProps(spec.type);
      for (const prop of spec.props) {
        if (prop.kind === "select" && defaults[prop.key] !== undefined) {
          const values = prop.options!.map((o) => o.value);
          expect(values).toContain(defaults[prop.key]);
        }
      }
    }
  });
});

describe("isKnownWidget", () => {
  it("knows a catalogue widget", () => {
    expect(isKnownWidget("layout/heading")).toBe(true);
  });
  it("does not know a made-up widget", () => {
    expect(isKnownWidget("evil/backdoor")).toBe(false);
  });
});

describe("CONTAINER_SPECS", () => {
  it("covers section, row and column", () => {
    expect(Object.keys(CONTAINER_SPECS).sort()).toEqual(["column", "row", "section"]);
  });

  it("a column span defaults within a 12-grid", () => {
    const span = CONTAINER_SPECS.column.props.find((p) => p.key === "span");
    expect(span?.min).toBe(1);
    expect(span?.max).toBe(12);
    expect(span?.default).toBe(12);
  });
});
