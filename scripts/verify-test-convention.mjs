import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const failures = [];
const legacyUntestedModules = new Set([
  "content-types", "jobs", "marketplace", "menus", "packages", "queue", "sites", "themes",
]);
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
function testFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? testFiles(file) : /\.test\.[cm]?[jt]sx?$/.test(entry.name) ? [file] : [];
  });
}

for (const group of ["apps", "packages", "plugins"]) {
  for (const entry of fs.readdirSync(path.join(root, group), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageFile = path.join(root, group, entry.name, "package.json");
    if (fs.existsSync(packageFile) && !readJson(packageFile).scripts?.test) {
      failures.push(`${group}/${entry.name}: missing package.json scripts.test`);
    }
  }
}

for (const entry of fs.readdirSync(path.join(root, "plugins"), { withFileTypes: true })) {
  if (entry.isDirectory() && testFiles(path.join(root, "plugins", entry.name, "test")).length === 0) {
    failures.push(`plugins/${entry.name}: add at least one test/*.test.ts`);
  }
}

const apiRoot = path.join(root, "apps/cms-api/src");
for (const entry of fs.readdirSync(apiRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const dir = path.join(apiRoot, entry.name);
  const isModule = fs.readdirSync(dir).some((file) => file.endsWith(".module.ts"));
  if (isModule && testFiles(dir).length === 0 && !legacyUntestedModules.has(entry.name)) {
    failures.push(`apps/cms-api/src/${entry.name}: module has no tests; use test/*.test.ts`);
  }
}

if (failures.length) {
  console.error(`Test convention failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("Test convention OK: workspace scripts, plugin suites, and module coverage are declared.");
