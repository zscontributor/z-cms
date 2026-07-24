import esbuild from "esbuild";
import fs from "node:fs";

/**
 * Builds `zcms` into a single self-contained file.
 *
 * This package is installed GLOBALLY, on the machine where an author keeps the
 * private key that signs everything they publish. Its dependency tree is
 * therefore part of its threat model, not an implementation detail: every
 * transitive package `npm i -g` pulls in is code that runs beside that key.
 *
 * So the published artefact has no dependencies at all. `@zcmsorg/package` (the
 * signing and archive code) and `tar-stream` are bundled in, which also means the
 * signing implementation that authors run is byte-for-byte the one this repo
 * builds, rather than whatever the registry resolved for them that day.
 *
 * The shebang is a banner rather than a line in main.ts, so that `tsx src/main.ts`
 * and the bundle do not disagree about which of them owns it.
 */
await esbuild.build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node22",
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "warning",
});

// `bin` entries are symlinked, not interpreted through `node` — a dist/main.js
// without the execute bit is a "permission denied" the first time anyone installs
// this globally.
fs.chmodSync("dist/main.js", 0o755);

console.log("zcms: dist/main.js");
