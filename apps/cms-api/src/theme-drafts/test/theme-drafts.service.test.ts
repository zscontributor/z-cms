import { describe, expect, it } from "vitest";
import { BadRequestException } from "@nestjs/common";
import {
  LayoutDocumentSchema,
  MAX_THEME_COLLECTIONS,
  type LayoutDocument,
  type LayoutNode,
} from "@zcmsorg/schemas";
import { ThemeDraftsService } from "../theme-drafts.module";

/**
 * `assertRenderable` catches the two ways a document can be schema-valid and still
 * render a broken page: it asks for more content lists than cms-api will run, or it
 * names a widget nothing can draw. Both fail SILENTLY at render time — an empty
 * list, a missing section — so they are refused at the door instead.
 */

const service = new ThemeDraftsService();

function widget(id: string, type: string, extra: Partial<LayoutNode> = {}): LayoutNode {
  return { id, kind: "widget", widgetType: type, props: {}, ...extra };
}

function docWith(...widgets: LayoutNode[]): LayoutDocument {
  return LayoutDocumentSchema.parse({
    version: 1,
    tokens: {},
    templates: {
      page: [
        {
          id: "s",
          kind: "section",
          props: {},
          children: [
            {
              id: "r",
              kind: "row",
              props: {},
              children: [{ id: "c", kind: "column", props: {}, children: widgets }],
            },
          ],
        },
      ],
    },
  });
}

function listWidget(id: string, contentType: string): LayoutNode {
  return widget(id, "dynamic/post-list", {
    binding: { source: "collection", contentType, limit: 6, sort: "newest" },
  });
}

describe("assertRenderable — collection budget", () => {
  it("accepts a document at the budget", () => {
    const atLimit = Array.from({ length: MAX_THEME_COLLECTIONS }, (_, i) =>
      listWidget(`w${i}`, `type${i}`),
    );
    expect(() => service.assertRenderable(docWith(...atLimit))).not.toThrow();
  });

  it("refuses one query over the budget", () => {
    // cms-api caps a manifest at MAX_THEME_COLLECTIONS and silently DROPS the rest,
    // so the ninth list would render empty forever with nothing to explain why.
    const over = Array.from({ length: MAX_THEME_COLLECTIONS + 1 }, (_, i) =>
      listWidget(`w${i}`, `type${i}`),
    );
    expect(() => service.assertRenderable(docWith(...over))).toThrow(BadRequestException);
  });

  it("counts deduplicated queries, not widgets", () => {
    // Twenty lists all asking for "the six newest posts" are ONE query. Counting
    // widgets would refuse a perfectly renderable design.
    const many = Array.from({ length: 20 }, (_, i) => listWidget(`w${i}`, "post"));
    expect(() => service.assertRenderable(docWith(...many))).not.toThrow();
  });
});

describe("assertRenderable — widget vocabulary", () => {
  it("accepts widgets the catalogue knows", () => {
    expect(() =>
      service.assertRenderable(docWith(widget("w", "layout/heading"))),
    ).not.toThrow();
  });

  it("refuses a widget this build cannot draw", () => {
    // The renderer SKIPS an unknown widget so an old runtime survives a new
    // document. But a document being written now, on this build, naming a widget
    // this build never heard of is a client bug — storing it would hide it until
    // somebody's page renders a hole.
    expect(() => service.assertRenderable(docWith(widget("w", "evil/backdoor")))).toThrow(
      BadRequestException,
    );
  });

  it("names every unknown widget it found", () => {
    try {
      service.assertRenderable(docWith(widget("a", "zz/one"), widget("b", "zz/two")));
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as BadRequestException).message).toContain("zz/one");
      expect((error as BadRequestException).message).toContain("zz/two");
    }
  });

  it("checks every template, not just page", () => {
    const doc = LayoutDocumentSchema.parse({
      version: 1,
      tokens: {},
      templates: {
        page: [],
        home: [
          {
            id: "s",
            kind: "section",
            props: {},
            children: [
              {
                id: "r",
                kind: "row",
                props: {},
                children: [
                  { id: "c", kind: "column", props: {}, children: [widget("w", "no/such")] },
                ],
              },
            ],
          },
        ],
      },
    });
    expect(() => service.assertRenderable(doc)).toThrow(BadRequestException);
  });
});
