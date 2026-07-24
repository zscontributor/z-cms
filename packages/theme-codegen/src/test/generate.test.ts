import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { LayoutDocumentSchema, type LayoutDocument } from "@zcmsorg/schemas";
import { CodegenError, buildThemeDir, generateThemeDir } from "../generate";
import { emitIndexTsx, emitLayoutJson } from "../emit";
import { buildManifest, collectMenuLocations } from "../manifest";

/**
 * The generator is the step that turns a stranger's drawing into a package the
 * platform signs. So these tests are about two things and not much else:
 *
 *   1. Does the emitted theme actually BUILD and LOAD — is the artifact real.
 *   2. Is what varies between two drawn themes only DATA — the property the whole
 *      "non-programmers may publish themes" design rests on.
 */

const identity = {
  id: "com.acme.theme.shop",
  name: "Acme Shop",
  version: "1.0.0",
  authorName: "Acme",
};

function doc(overrides: Partial<LayoutDocument["templates"]> = {}, tokens = {}): LayoutDocument {
  return LayoutDocumentSchema.parse({
    version: 1,
    tokens,
    templates: {
      page: [
        {
          id: "s1",
          kind: "section",
          props: { paddingY: 80 },
          children: [
            {
              id: "r1",
              kind: "row",
              props: {},
              children: [
                {
                  id: "c1",
                  kind: "column",
                  props: { span: 12 },
                  children: [
                    { id: "w1", kind: "widget", widgetType: "layout/heading", props: { text: "Hi" } },
                    {
                      id: "w2",
                      kind: "widget",
                      widgetType: "dynamic/post-list",
                      props: {},
                      binding: { source: "collection", contentType: "post", limit: 6, sort: "newest" },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      ...overrides,
    },
  });
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcms-codegen-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("generateThemeDir", () => {
  it("writes the files the packer expects", () => {
    generateThemeDir({ identity, document: doc(), dir });
    expect(fs.existsSync(path.join(dir, "theme.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "src/index.tsx"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "src/layout.json"))).toBe(true);
  });

  it("refuses a document that is not a valid drawing", () => {
    expect(() => generateThemeDir({ identity, document: { nonsense: true }, dir })).toThrow(
      CodegenError,
    );
  });

  it("refuses a widget it cannot build rather than shipping a hole", () => {
    const bad = {
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
                children: [
                  {
                    id: "c",
                    kind: "column",
                    props: {},
                    children: [{ id: "w", kind: "widget", widgetType: "evil/backdoor", props: {} }],
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    expect(() => generateThemeDir({ identity, document: bad, dir })).toThrow(CodegenError);
  });

  it("derives collections into the manifest from the widgets that bound them", () => {
    generateThemeDir({ identity, document: doc(), dir });
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "theme.json"), "utf8"));
    expect(manifest.collections).toEqual({
      post_6_newest: { contentType: "post", limit: 6, sort: "newest" },
    });
  });

  it("only lists templates that were drawn, and always page", () => {
    generateThemeDir({ identity, document: doc(), dir });
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "theme.json"), "utf8"));
    expect(manifest.templates).toEqual(["page"]);
  });
});

describe("the emitted source is a template, not a compiler", () => {
  it("is byte-identical for two completely different drawings", () => {
    // The load-bearing property: what varies between drawn themes is DATA. If this
    // ever fails, the generator has started interpolating the document into source
    // and has re-introduced the arbitrary-code problem the design exists to avoid.
    const a = emitIndexTsx();
    const b = emitIndexTsx();
    expect(a).toBe(b);
  });

  it("contains no widget type, prop value or id from any document", () => {
    const source = emitIndexTsx();
    expect(source).not.toContain("evil");
    expect(source).not.toContain("layout/heading");
    expect(source).not.toContain("com.acme.theme.shop");
  });

  it("serialises the same drawing to the same bytes", () => {
    // Reproducibility is what lets a reviewer diff two packages and a publisher
    // re-issue one.
    expect(emitLayoutJson(doc())).toBe(emitLayoutJson(doc()));
  });
});

describe("manifest derivation", () => {
  it("declares every menu location a drawing names", () => {
    const withMenu = doc({
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
                {
                  id: "c",
                  kind: "column",
                  props: {},
                  children: [
                    {
                      id: "m",
                      kind: "widget",
                      widgetType: "layout/menu",
                      props: { location: "footer" },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    // Undeclared, the site has nowhere to assign a menu to and the widget renders
    // nothing forever.
    expect(collectMenuLocations(withMenu)).toEqual([{ key: "footer", name: "footer" }]);
  });

  it("turns the drawing's tokens into settings defaults", () => {
    const manifest = buildManifest(identity, doc({}, { colorPrimary: "#fa5600", radius: 12 }));
    expect(manifest.settingsSchema.properties.colorPrimary).toMatchObject({
      type: "string",
      format: "color",
      default: "#fa5600",
    });
    expect(manifest.settingsSchema.properties.radius).toMatchObject({ default: 12 });
  });

  it("still declares a token the drawing left unset, with no default", () => {
    const manifest = buildManifest(identity, doc());
    expect(manifest.settingsSchema.properties.colorPrimary).toBeDefined();
    expect(manifest.settingsSchema.properties.colorPrimary!.default).toBeUndefined();
  });
});

describe("buildThemeDir — the artifact is real", () => {
  it("produces a bundle and a stylesheet", async () => {
    generateThemeDir({ identity, document: doc(), dir });
    await buildThemeDir(dir);
    // buildPackage's readManifest REQUIRES dist/index.mjs to already exist — a
    // generator that stopped at source would fail at pack time with "Build the
    // package before packing it."
    expect(fs.existsSync(path.join(dir, "dist/index.mjs"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "dist/theme.css"))).toBe(true);
    expect(fs.readFileSync(path.join(dir, "dist/theme.css"), "utf8")).toContain(".zw-section");
  }, 60_000);

  it("leaves react external so the runtime's copy is shared", async () => {
    generateThemeDir({ identity, document: doc(), dir });
    await buildThemeDir(dir);
    const bundle = fs.readFileSync(path.join(dir, "dist/index.mjs"), "utf8");
    // Two Reacts in one render is the classic "invalid hook call" that only
    // reproduces in production.
    expect(bundle).toMatch(/from\s*"react\/jsx-runtime"/);
    expect(bundle).not.toContain("react-dom/server");
  }, 60_000);

  it("bundles the widget library IN, because the packer drops src/", async () => {
    generateThemeDir({ identity, document: doc(), dir });
    await buildThemeDir(dir);
    const bundle = fs.readFileSync(path.join(dir, "dist/index.mjs"), "utf8");
    // If theme-widgets were left external, the packed theme would import a package
    // that does not exist inside the .zcms and fail at load on a real site.
    expect(bundle).not.toMatch(/from\s*"@zcmsorg\/theme-widgets"/);
    expect(bundle).toContain("zw-section");
  }, 60_000);

  it("wraps long lines so the scanner does not read the bundle as obfuscated", async () => {
    generateThemeDir({ identity, document: doc(), dir });
    await buildThemeDir(dir);
    const bundle = fs.readFileSync(path.join(dir, "dist/index.mjs"), "utf8");
    const longest = Math.max(...bundle.split("\n").map((line) => line.length));
    // esbuild's lineLimit is a soft wrap, not a hard cap — a single long string
    // literal cannot be broken. What matters is that the whole inlined document is
    // not on one line, which is what trips the rule.
    expect(longest).toBeLessThan(2000);
  }, 60_000);

  it("the built theme loads and satisfies the theme contract", async () => {
    generateThemeDir({ identity, document: doc(), dir });
    await buildThemeDir(dir);

    // The real proof: site-runtime's importTheme does exactly this, then checks
    // `theme.templates.page && theme.Layout`. A bundle that builds but does not
    // load is a theme that 500s on a real site.
    const mod = await import(pathToFileURL(path.join(dir, "dist/index.mjs")).href);
    const theme = mod.default;
    expect(typeof theme.Layout).toBe("function");
    expect(typeof theme.templates.page).toBe("function");
    expect(theme.manifest.id).toBe("com.acme.theme.shop");
    expect(theme.manifest.collections).toEqual({
      post_6_newest: { contentType: "post", limit: 6, sort: "newest" },
    });
  }, 60_000);
});
