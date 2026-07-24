import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isEmptyEnough,
  packageNameFor,
  scaffold,
  slugOf,
  suggestId,
  suggestName,
  validateId,
  validateVersion,
  writeScaffold,
  type InitOptions,
} from "../init";

/** This CLI's own version — the single source the scaffold's ranges derive from. */
const { version: CLI_VERSION } = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8"),
) as { version: string };

/**
 * Two layers here, deliberately.
 *
 * The pure layer (`scaffold`) is asserted directly, and most of what it asserts
 * is not "the file exists" but "the file says the thing that makes the package
 * work": a plugin entry that is CommonJS, a theme entry that is `.mjs` with React
 * external. Those are the contracts the sandbox and the site runtime enforce at
 * *runtime*, on someone's live site — a scaffold that quietly stopped satisfying
 * them would produce packages that build, test, pack, sign, install, and then
 * fail in front of a user.
 *
 * The subprocess layer drives the real binary, because argument parsing and the
 * refusal to overwrite are the parts an author actually collides with.
 */

const execFileAsync = promisify(execFile);

const MAIN = path.join(__dirname, "..", "main.ts");
const TSX = path.join(__dirname, "..", "..", "node_modules", ".bin", "tsx");

interface Run {
  stdout: string;
  stderr: string;
  code: number;
}

async function zcms(args: string[]): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileAsync(TSX, [MAIN, ...args]);
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code ?? 1 };
  }
}

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "zcms-init-test-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function options(overrides: Partial<InitOptions> = {}): InitOptions {
  return {
    kind: "plugin",
    id: "com.acme.plugin.hello",
    name: "Hello",
    description: "Says hello.",
    version: "0.1.0",
    authorName: "Acme",
    authorUrl: "",
    ...overrides,
  };
}

describe("id validation", () => {
  it("accepts a reverse-DNS id", () => {
    expect(validateId("com.acme.plugin.hello")).toBeNull();
    expect(validateId("vn.zsoft.theme.aurora")).toBeNull();
    expect(validateId("io.my-org.plugin.thing-2")).toBeNull();
  });

  it("rejects an id that is not reverse-DNS", () => {
    // The id keys a directory in every runtime's package cache and a path segment
    // on the marketplace. The loader sanitises it — an id that HAS to be
    // sanitised is one that will not be what its author thinks it is.
    expect(validateId("Hello")).toMatch(/reverse-DNS/);
    expect(validateId("com/acme/hello")).toMatch(/reverse-DNS/);
    expect(validateId("com.Acme.Plugin")).toMatch(/reverse-DNS/);
    expect(validateId("com..hello")).toMatch(/reverse-DNS/);
    expect(validateId("")).toMatch(/required/);
  });

  it("rejects an id too short to be unique", () => {
    expect(validateId("com.hello")).toMatch(/too short/);
  });
});

describe("version validation", () => {
  it("accepts semver", () => {
    expect(validateVersion("0.1.0")).toBeNull();
    expect(validateVersion("1.2.3-beta.1")).toBeNull();
  });

  it("rejects anything else", () => {
    expect(validateVersion("1.0")).toMatch(/semantic version/);
    expect(validateVersion("v1.0.0")).toMatch(/semantic version/);
  });
});

describe("names derived from an id", () => {
  it("takes the slug from the last segment", () => {
    expect(slugOf("com.acme.plugin.hello")).toBe("hello");
  });

  it("prefixes the npm name by kind, so a plugin and a theme can share a slug", () => {
    expect(packageNameFor("plugin", "com.acme.plugin.hello")).toBe("zcms-plugin-hello");
    expect(packageNameFor("theme", "com.acme.theme.hello")).toBe("zcms-theme-hello");
  });

  it("suggests an id from a human name, and a human name from an id", () => {
    expect(suggestId("theme", "My Great Theme")).toBe("com.example.theme.my-great-theme");
    expect(suggestName("com.acme.plugin.hello-world")).toBe("Hello World");
  });
});

describe("scaffold — plugin", () => {
  const files = scaffold(options());

  it("writes a manifest the packer will accept", () => {
    // readManifest() requires exactly these, and rejects the package otherwise.
    const manifest = JSON.parse(files["plugin.json"] as string);

    expect(manifest).toMatchObject({
      id: "com.acme.plugin.hello",
      name: "Hello",
      version: "0.1.0",
      author: { name: "Acme" },
      engine: `>=${CLI_VERSION}`,
      entry: "dist/index.js",
    });
  });

  it("points the scaffold at the SDK version this CLI ships with", () => {
    // The CLI and the SDKs are published in lockstep. A scaffold that asked for
    // an older SDK than the CLI it came from would hand the author a type error
    // in code they did not write — so these ranges are derived, never written
    // down. This test is what keeps them derived.
    const pkg = JSON.parse(files["package.json"] as string);

    expect(pkg.devDependencies["@zcmsorg/plugin-sdk"]).toBe(`^${CLI_VERSION}`);
    expect(pkg.devDependencies["@zcmsorg/cli"]).toBe(`^${CLI_VERSION}`);
  });

  it("builds to ONE CommonJS file with the SDK external", () => {
    // The sandbox evaluates a single CJS script and provides exactly one module.
    // `format: "esm"` here would be a SyntaxError inside the isolate; a missing
    // `bundle` would emit relative require()s the sandbox cannot resolve; and
    // bundling the SDK would shadow the real one. All three fail at activation
    // time, on a site, not here.
    const build = files["build.mjs"] as string;

    expect(build).toContain('format: "cjs"');
    expect(build).toContain("bundle: true");
    expect(build).toContain('external: ["@zcmsorg/plugin-sdk"]');
    expect(build).toContain('outfile: "dist/index.js"');
  });

  it("imports nothing the sandbox does not provide", () => {
    // The publish-time scanner blocks these outright. A scaffold that shipped one
    // would hand every new author a package the marketplace refuses.
    const source = files["src/index.ts"] as string;

    expect(source).not.toMatch(/from "node:|require\(["'](?:node:)?fs/);
    expect(source).not.toMatch(/\bprocess\s*\.\s*env\b/);
    expect(source).not.toMatch(/\beval\s*\(|\bnew Function\s*\(/);
    expect(source).toContain('from "@zcmsorg/plugin-sdk"');
  });

  it("gitignores the private key", () => {
    // A publisher private key in a public repo ends that publisher's identity:
    // every package it ever signed becomes forgeable. keygen writes it into the
    // project directory, so the ignore has to be there before the key is.
    expect(files[".gitignore"]).toContain("*.pem");
  });
});

describe("scaffold — theme", () => {
  const files = scaffold(options({ kind: "theme", id: "com.acme.theme.aurora", name: "Aurora" }));

  it("declares an .mjs entry, not a .js one", () => {
    // A dist/index.js takes its module format from the nearest package.json
    // "type" — and package.json ships INSIDE the payload. When the runtime guesses
    // wrong it throws "Cannot use import statement outside a module", catches it,
    // and silently falls back to the default theme. .mjs is ESM unconditionally.
    const manifest = JSON.parse(files["theme.json"] as string);

    expect(manifest.entry).toBe("dist/index.mjs");
    expect(manifest.styles).toBe("dist/theme.css");
    expect(manifest.templates).toContain("page");
  });

  it("keeps React external so the theme shares the host's React instance", () => {
    // Two copies of React in one render is the classic way for a theme system to
    // produce "invalid hook call" — in production only.
    const build = files["build.mjs"] as string;

    expect(build).toContain('format: "esm"');
    expect(build).toContain('external: ["react", "react/jsx-runtime", "react-dom"]');
    expect(files["package.json"]).toContain("peerDependencies");
  });

  it("ships its own stylesheet", () => {
    // The host's CSS was generated by scanning the host's source; it has never
    // seen this theme's class names. Relying on it renders correct markup, unstyled.
    expect(files["src/theme.css"]).toBeTruthy();
    expect(files["build.mjs"]).toContain("dist/theme.css");
  });

  it("provides every template the manifest promises", () => {
    const source = files["src/index.tsx"] as string;

    for (const template of ["home", "page", "post", "archive", "notFound", "error"]) {
      expect(source).toContain(`${template}:`);
    }
  });
});

describe("scaffold — refusals", () => {
  it("refuses an invalid id before writing anything", () => {
    expect(() => scaffold(options({ id: "Hello" }))).toThrow(/reverse-DNS/);
  });

  it("refuses an invalid version", () => {
    expect(() => scaffold(options({ version: "1.0" }))).toThrow(/semantic version/);
  });
});

describe("writeScaffold", () => {
  it("writes every file, creating directories as it goes", () => {
    const dir = path.join(tmp, "hello");

    const written = writeScaffold(dir, scaffold(options()));

    expect(written).toContain("src/index.ts");
    expect(written).toContain("test/plugin.test.ts");
    expect(fs.existsSync(path.join(dir, "src", "index.ts"))).toBe(true);
  });

  it("treats a directory holding only .git as empty", () => {
    // `mkdir x && cd x && git init && zcms init` is a normal thing to do, and
    // being told to start over for it would be pedantry.
    const dir = path.join(tmp, "fresh");
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });

    expect(isEmptyEnough(dir)).toBe(true);
    expect(() => writeScaffold(dir, scaffold(options()))).not.toThrow();
  });

  it("refuses to write into a directory that holds anything else", () => {
    // The failure this prevents: an author runs init in the wrong terminal and it
    // eats their work. There is no --force; `rm -rf` is already spelled `rm -rf`.
    const dir = path.join(tmp, "occupied");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "important.ts"), "// a year of work\n");

    expect(() => writeScaffold(dir, scaffold(options()))).toThrow(/not empty/);
    expect(fs.readFileSync(path.join(dir, "important.ts"), "utf8")).toContain("a year of work");
  });
});

describe("zcms init (the real binary)", () => {
  it("scaffolds a plugin non-interactively", async () => {
    const dir = path.join(tmp, "hello");

    const { code } = await zcms([
      "init", dir, "--yes", "--kind", "plugin", "--id", "com.acme.plugin.hello", "--author", "Acme",
    ]);

    expect(code).toBe(0);
    expect(fs.existsSync(path.join(dir, "plugin.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "src", "index.ts"))).toBe(true);
  });

  it("scaffolds a theme non-interactively", async () => {
    const dir = path.join(tmp, "aurora");

    const { code } = await zcms([
      "init", dir, "--yes", "--kind", "theme", "--id", "com.acme.theme.aurora", "--author", "Acme",
    ]);

    expect(code).toBe(0);
    expect(fs.existsSync(path.join(dir, "theme.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "src", "index.tsx"))).toBe(true);
  });

  it("defaults the directory to the id's last segment", async () => {
    // `zcms init --kind plugin --id com.acme.plugin.hello` with no path should
    // land somewhere predictable rather than splatting into the cwd.
    const { code } = await execFileAsync(TSX, [
      MAIN, "init", "--yes", "--kind", "plugin", "--id", "com.acme.plugin.hello", "--author", "Acme",
    ], { cwd: tmp }).then(
      () => ({ code: 0 }),
      (err: { code?: number }) => ({ code: err.code ?? 1 }),
    );

    expect(code).toBe(0);
    expect(fs.existsSync(path.join(tmp, "hello", "plugin.json"))).toBe(true);
  });

  it("fails rather than hanging when it cannot ask and was not told", async () => {
    // stdin is a pipe in a test (and in CI). A prompt written to a pipe is not a
    // prompt, it is a hang — so the missing-flags case must be an error.
    const { stderr, code } = await zcms(["init", path.join(tmp, "x")]);

    expect(stderr).toMatch(/--kind/);
    expect(code).toBe(1);
  });

  it("rejects a bad id at the command line", async () => {
    const { stderr, code } = await zcms([
      "init", path.join(tmp, "x"), "--yes", "--kind", "plugin", "--id", "Nope",
    ]);

    expect(stderr).toMatch(/reverse-DNS/);
    expect(code).toBe(1);
  });

  it("refuses to overwrite an occupied directory", async () => {
    const dir = path.join(tmp, "occupied");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "important.ts"), "// a year of work\n");

    const { stderr, code } = await zcms([
      "init", dir, "--yes", "--kind", "plugin", "--id", "com.acme.plugin.hello",
    ]);

    expect(stderr).toMatch(/not empty/);
    expect(code).toBe(1);
    expect(fs.readFileSync(path.join(dir, "important.ts"), "utf8")).toContain("a year of work");
  });
});
