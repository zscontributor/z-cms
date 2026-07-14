import * as acorn from "acorn";
import { DANGEROUS_MODULES, SUSPICIOUS_MODULES } from "./rules";
import type { Finding } from "./types";

/**
 * The AST pass — what the line-by-line regexes structurally cannot see.
 *
 * The regex rules match source TEXT, so `require("child" + "_process")` slips
 * past them: the literal "child_process" never appears on any line. That is not a
 * bug in the regexes, it is the ceiling of the technique, and this file raises it
 * for the handful of evasions that matter by reading the parse tree instead:
 *
 *   - a dangerous module reached through a string BUILT at runtime
 *     (concatenation, a template with no interpolation) — folded to its value;
 *   - `process` (or a host global) read through a COMPUTED key, `process["e"+"nv"]`,
 *     which no `process.env` text rule can catch;
 *   - MONKEY-PATCHING a shared global — `globalThis.fetch = …` — the specific move
 *     a theme uses to observe or rewrite another tenant's render in the one Node
 *     process every site shares.
 *
 * It is ADDITIVE. The regex rules still run; this only reports what they miss, and
 * under different rule ids so nothing is double-counted. A file this cannot parse
 * is left to the regex + obfuscation heuristics — a parse failure is never fatal,
 * because scanning hostile code must never be a way to run or crash on it.
 */

const DANGEROUS = new Set(DANGEROUS_MODULES);
const SUSPICIOUS = new Set(SUSPICIOUS_MODULES);
const HOST_GLOBALS = new Set(["globalThis", "global"]);
// Globals whose reassignment lets a theme see or alter every tenant's render in
// the shared process. Patching these is never legitimate in a rendered package.
const SENSITIVE_GLOBAL_TARGETS = new Set([
  "fetch",
  "Request",
  "Response",
  "Headers",
  "XMLHttpRequest",
  "WebSocket",
  "process",
  "require",
  "Function",
  "eval",
  "Reflect",
  "Proxy",
]);

export function scanAst(file: string, source: string): Finding[] {
  const ast = parse(source);
  if (!ast) return []; // unparseable — regex + heuristics still apply

  const findings: Finding[] = [];
  const seen = new Set<string>(); // one finding per (rule) per file is enough

  walk(ast as unknown as AnyNode, (node) => {
    checkDangerousImport(node, file, findings, seen);
    checkComputedHostAccess(node, file, findings, seen);
    checkGlobalMonkeyPatch(node, file, findings, seen);
  });

  return findings;
}

function parse(source: string): acorn.Node | null {
  const opts: acorn.Options = {
    ecmaVersion: "latest",
    locations: true,
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    allowSuperOutsideMethod: true,
    allowHashBang: true,
  };
  try {
    return acorn.parse(source, { ...opts, sourceType: "module" });
  } catch {
    try {
      return acorn.parse(source, { ...opts, sourceType: "script" });
    } catch {
      return null;
    }
  }
}

/** require(x) / import(x) where x folds to a dangerous module built at runtime. */
function checkDangerousImport(
  node: AnyNode,
  file: string,
  out: Finding[],
  seen: Set<string>,
): void {
  // acorn models `import(x)` as an ImportExpression, and `require(x)` as an
  // ordinary CallExpression — handle both, and read the argument each carries.
  let arg: AnyNode | undefined;
  if (node.type === "ImportExpression") {
    arg = node.source as AnyNode | undefined;
  } else if (node.type === "CallExpression") {
    const callee = node.callee as AnyNode;
    if (callee.type === "Identifier" && callee.name === "require") {
      arg = node.arguments?.[0];
    }
  }
  if (!arg) return;

  const value = staticString(arg);
  if (value === null) return; // a plain variable — the regex dynamic-require/-import warn covers it

  const literal = arg.type === "Literal"; // a bare string literal is already caught by the module rules
  if (literal) return;

  if (DANGEROUS.has(value)) {
    push(out, seen, {
      severity: "block",
      rule: "dangerous-module-computed",
      message: `Loads the built-in "${value}" through a string assembled at runtime, evading the literal import check.`,
      file,
      line: lineOf(node),
    });
  } else if (SUSPICIOUS.has(value)) {
    push(out, seen, {
      severity: "warn",
      rule: "host-info-computed",
      message: `Loads the built-in "${value}" through a string assembled at runtime.`,
      file,
      line: lineOf(node),
    });
  }
}

/** process[<computed>] — reading the environment past the `process.env` text rule. */
function checkComputedHostAccess(
  node: AnyNode,
  file: string,
  out: Finding[],
  seen: Set<string>,
): void {
  if (node.type !== "MemberExpression" || !node.computed) return;
  const obj = node.object as AnyNode;

  // process[...]  or  globalThis.process[...] / global.process[...]
  const isProcess =
    (obj.type === "Identifier" && obj.name === "process") ||
    (obj.type === "MemberExpression" &&
      !obj.computed &&
      obj.property?.type === "Identifier" &&
      obj.property.name === "process");
  if (!isProcess) return;

  // A plain literal key (process["env"]) is not itself evasion, but a computed or
  // assembled key (process["e"+"nv"], process[k]) is exactly how the text rule is
  // dodged. Flag anything that is not a bare, single string literal.
  if (node.property?.type === "Literal" && typeof node.property.value === "string") {
    // process["env"] — still worth a look, but the text rule already warns on it.
    return;
  }
  push(out, seen, {
    severity: "warn",
    rule: "process-computed-access",
    message: "Reads a `process` property through a computed key — a way past the process.env text rule.",
    file,
    line: lineOf(node),
  });
}

/** globalThis.fetch = … / global.process = … — patching a shared host global. */
function checkGlobalMonkeyPatch(
  node: AnyNode,
  file: string,
  out: Finding[],
  seen: Set<string>,
): void {
  if (node.type !== "AssignmentExpression") return;
  const left = node.left as AnyNode;
  if (left.type !== "MemberExpression") return;

  const obj = left.object as AnyNode;
  const target =
    left.property?.type === "Identifier"
      ? left.property.name
      : left.property?.type === "Literal" && typeof left.property.value === "string"
        ? left.property.value
        : undefined;

  // globalThis.<x> = …  /  global.<x> = …
  if (obj.type === "Identifier" && HOST_GLOBALS.has(obj.name)) {
    const sensitive = target !== undefined && SENSITIVE_GLOBAL_TARGETS.has(target);
    push(out, seen, {
      severity: sensitive ? "block" : "warn",
      rule: sensitive ? "monkeypatch-sensitive-global" : "monkeypatch-global",
      message: sensitive
        ? `Reassigns the shared global "${obj.name}.${target}" — in the render process every tenant shares, this observes or rewrites other sites.`
        : `Assigns to a shared host global (${obj.name}). A rendered package must not mutate process-wide state.`,
      file,
      line: lineOf(node),
    });
  }
}

// --- static evaluation & tree walk ---------------------------------------

/**
 * Folds a node to a constant string if it is one: a string literal, a template
 * with no interpolation, or a `+` chain of those. Anything dynamic returns null.
 */
function staticString(node: AnyNode | undefined): string | null {
  if (!node) return null;
  if (node.type === "Literal") {
    return typeof node.value === "string" ? node.value : null;
  }
  if (node.type === "TemplateLiteral") {
    if (node.expressions?.length) return null; // has interpolation
    return (node.quasis ?? []).map((q: AnyNode) => q.value?.cooked ?? "").join("");
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const l = staticString(node.left as AnyNode);
    const r = staticString(node.right as AnyNode);
    return l !== null && r !== null ? l + r : null;
  }
  return null;
}

interface AnyNode {
  type: string;
  loc?: { start: { line: number } };
  // Acorn nodes are structurally dynamic; this walker reads whatever child a node
  // type carries. `any` on the index is deliberate — the shape is validated by the
  // `type` checks at each use site, not by the compiler.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

/** Depth-first visit of every AST node, without pulling in acorn-walk. */
function walk(node: AnyNode, visit: (n: AnyNode) => void): void {
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "start" || key === "end") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === "object" && typeof (child as AnyNode).type === "string") {
          walk(child as AnyNode, visit);
        }
      }
    } else if (value && typeof value === "object" && typeof (value as AnyNode).type === "string") {
      walk(value as AnyNode, visit);
    }
  }
}

function lineOf(node: AnyNode): number | undefined {
  return node.loc?.start.line;
}

function push(out: Finding[], seen: Set<string>, finding: Finding): void {
  if (seen.has(finding.rule)) return;
  seen.add(finding.rule);
  out.push(finding);
}
