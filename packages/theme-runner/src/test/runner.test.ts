import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderTheme, forgetThemeWorker, residentWorkerCount } from "../runner";

/**
 * Every case here is an attack, not an example.
 *
 * The bar is the one the old design could not clear: site-runtime imported a theme
 * onto the request thread, so `while(true){}` in a component took every tenant down
 * and nothing in-process could stop it. These tests fail if that is true again.
 *
 * They render REAL theme modules — written to a temp dir and imported by the worker
 * exactly as a verified bundle would be. A mocked worker would prove nothing: the
 * whole claim is about what a thread does when the code on it will not yield.
 */

const dirs: string[] = [];

/**
 * Writes a throwaway ESM theme and returns its entry path.
 *
 * Under this package's own directory, NOT os.tmpdir(), and that placement is a
 * finding rather than a convenience. A theme bundle declares `react` external
 * (themes/*\/build.mjs: `external: ["react", "react/jsx-runtime", "react-dom"]`) so
 * it shares one React with its host — two Reacts in one render is the classic route
 * to "invalid hook call". Sharing means the bundle carries a bare `import "react"`,
 * and Node resolves that by walking up from the FILE for a node_modules. From
 * os.tmpdir() there is none, and the import fails before a single test assertion.
 *
 * That is not a test artefact. `THEME_CACHE_DIR` defaults to
 * `process.cwd()/.zcms-themes` — inside the app tree, where the walk finds
 * node_modules — but z-cms.stack.yml sets it to `/tmp/zcms-themes`, where it does
 * not. See the note in runner.ts: resolving React for the theme is the next piece
 * of work, and it is owed to production, not to this file.
 */
function theme(source: string): string {
  const dir = fs.mkdtempSync(path.join(__dirname, "..", "..", ".fixtures-"));
  dirs.push(dir);
  const entry = path.join(dir, "index.mjs");
  fs.writeFileSync(entry, source);
  return entry;
}
void os;

const PAYLOAD = {
  site: { id: "s1", name: "T", locale: "en", defaultLocale: "en", hostname: "t.test" },
  theme: { settings: {} },
  menus: {},
  capabilities: [],
  alternates: [],
  collections: {},
};

const req = (entryPath: string, over: Record<string, unknown> = {}) => ({
  key: "test.theme",
  version: "1.0.0",
  entryPath,
  assetBase: "/a/",
  template: "page",
  payload: PAYLOAD,
  content: { title: "T", blocks: [] },
  ...over,
});

/** A theme that renders, so the fixtures stay readable. */
const BENIGN = `
import React from "react";
export default {
  manifest: { id: "test.theme", settingsSchema: { type: "object", properties: {} } },
  messages: {},
  Layout: ({ ctx, children }) => React.createElement("main", { "data-site": ctx.site.name }, children),
  templates: { page: ({ content }) => React.createElement("h1", null, content.title) },
  blocks: {},
};
`;

afterEach(async () => {
  await forgetThemeWorker("test.theme", "1.0.0");
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("renderTheme", () => {
  it("renders a benign theme to HTML", async () => {
    const r = await renderTheme(req(theme(BENIGN)));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.html).toContain("<h1>T</h1>");
      expect(r.html).toContain('data-site="T"');
    }
  });

  it("kills a theme that loops forever instead of hanging the caller", async () => {
    const hostile = theme(`
      import React from "react";
      export default {
        manifest: { id: "test.theme", settingsSchema: { type: "object", properties: {} } },
        messages: {},
        Layout: ({ children }) => React.createElement("main", null, children),
        templates: { page: () => { while (true) {} } },
        blocks: {},
      };
    `);

    const started = Date.now();
    const r = await renderTheme(req(hostile, { timeoutMs: 700 }));

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.killed).toBe(true);
    // The whole point: it RETURNS. In-process this call never came back.
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it("stays usable after a theme tried to loop forever", async () => {
    const hostile = theme(`
      import React from "react";
      export default {
        manifest: { id: "test.theme", settingsSchema: { type: "object", properties: {} } },
        messages: {},
        Layout: ({ children }) => React.createElement("main", null, children),
        templates: { page: () => { while (true) {} } },
        blocks: {},
      };
    `);
    await renderTheme(req(hostile, { timeoutMs: 500 }));

    // A different theme is untouched by the one that was killed — the isolation
    // claim, tested rather than asserted.
    const r = await renderTheme(req(theme(BENIGN), { key: "other.theme" }));
    expect(r.ok).toBe(true);
    await forgetThemeWorker("other.theme", "1.0.0");
  });

  it("kills a theme that allocates without bound instead of taking the host with it", async () => {
    const bomb = theme(`
      import React from "react";
      const eat = [];
      export default {
        manifest: { id: "test.theme", settingsSchema: { type: "object", properties: {} } },
        messages: {},
        Layout: ({ children }) => React.createElement("main", null, children),
        templates: { page: () => { for (;;) eat.push(new Array(1e6).fill("x")); } },
        blocks: {},
      };
    `);

    const r = await renderTheme(req(bomb, { timeoutMs: 15_000 }));
    expect(r.ok).toBe(false);
    // Either V8 kills the isolate on the heap cap, or the deadline does. Both are
    // containment; which one wins is a race we do not need to care about.
  }, 30_000);

  it("reports a theme that throws without killing its worker", async () => {
    const boom = theme(`
      import React from "react";
      export default {
        manifest: { id: "test.theme", settingsSchema: { type: "object", properties: {} } },
        messages: {},
        Layout: ({ children }) => React.createElement("main", null, children),
        templates: { page: () => { throw new Error("kaboom"); } },
        blocks: {},
      };
    `);

    const r = await renderTheme(req(boom));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("kaboom");
      // A throw is not a hang: killing the worker here would cost every other page
      // on this theme a 118ms respawn for one broken template.
      expect(r.killed).toBe(false);
    }
  });

  it("gives a theme no process.env to read", async () => {
    process.env.ZCMS_RUNNER_LEAK_CANARY = "render-token-shaped-secret";

    const peek = theme(`
      import React from "react";
      export default {
        manifest: { id: "test.theme", settingsSchema: { type: "object", properties: {} } },
        messages: {},
        Layout: ({ children }) => React.createElement("main", null, children),
        templates: { page: () =>
          React.createElement("pre", null, JSON.stringify({
            canary: process.env.ZCMS_RUNNER_LEAK_CANARY ?? "absent",
            keys: Object.keys(process.env).length,
          })),
        },
        blocks: {},
      };
    `);

    const r = await renderTheme(req(peek));
    delete process.env.ZCMS_RUNNER_LEAK_CANARY;

    expect(r.ok).toBe(true);
    if (r.ok) {
      // site-runtime holds SITE_RUNTIME_INTERNAL_TOKEN in its env. In-process, a
      // theme reads it. Here there is nothing to read.
      expect(r.html).toContain("absent");
      expect(r.html).not.toContain("render-token-shaped-secret");
    }
  });

  it("reuses one worker per theme rather than spawning per render", async () => {
    const entry = theme(BENIGN);
    await renderTheme(req(entry));
    await renderTheme(req(entry));
    await renderTheme(req(entry));

    // 118ms cold vs 1.16ms warm is the entire reason the pool exists. If this ever
    // reads 3, every page on the site just got 100ms slower.
    expect(residentWorkerCount()).toBe(1);
  });

  it("isolates a throwing block to that block and still renders the page", async () => {
    const withBlocks = theme(`
      import React from "react";
      export default {
        manifest: { id: "test.theme", settingsSchema: { type: "object", properties: {} } },
        messages: {},
        Layout: ({ children }) => React.createElement("main", null, children),
        templates: { page: ({ ctx, content }) =>
          React.createElement("div", null, ctx.renderBlocks(content.blocks)) },
        blocks: {
          good: () => React.createElement("p", null, "survived"),
          bad: () => { throw new Error("bad block"); },
        },
      };
    `);

    const r = await renderTheme(
      req(withBlocks, {
        content: {
          title: "T",
          blocks: [
            { id: "b1", type: "good" },
            { id: "b2", type: "bad" },
            { id: "b3", type: "good" },
          ],
        },
      }),
    );

    expect(r.ok).toBe(true);
    if (r.ok) {
      // The bad block is gone; the two good ones are not. This is what BlockBoundary
      // did — except this also survives the case BlockBoundary never could.
      expect(r.html).not.toContain("bad block");
      expect(r.html.match(/survived/g)).toHaveLength(2);
    }
  });

  it("skips a block type the theme does not register rather than failing the page", async () => {
    const withBlocks = theme(`
      import React from "react";
      export default {
        manifest: { id: "test.theme", settingsSchema: { type: "object", properties: {} } },
        messages: {},
        Layout: ({ children }) => React.createElement("main", null, children),
        templates: { page: ({ ctx, content }) =>
          React.createElement("div", null, ctx.renderBlocks(content.blocks)) },
        blocks: { known: () => React.createElement("p", null, "known") },
      };
    `);

    const r = await renderTheme(
      req(withBlocks, {
        content: {
          title: "T",
          blocks: [
            { id: "b1", type: "known" },
            { id: "b2", type: "commerce/product-grid" },
          ],
        },
      }),
    );

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.html).toContain("known");
  });

  it("falls back to templates.page when the requested template is missing", async () => {
    const r = await renderTheme(req(theme(BENIGN), { template: "archive" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.html).toContain("<h1>T</h1>");
  });

  it("terminates the worker on revocation, which is a real unload", async () => {
    await renderTheme(req(theme(BENIGN)));
    expect(residentWorkerCount()).toBe(1);

    await forgetThemeWorker("test.theme", "1.0.0");

    // site-runtime's forgetTheme only drops a Map entry — Node's ESM loader has no
    // unload, so revoked code stayed resident until a redeploy. Terminating the
    // thread that holds the module is the unload.
    expect(residentWorkerCount()).toBe(0);
  });
});
