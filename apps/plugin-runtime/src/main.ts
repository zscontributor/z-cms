import path from "node:path";
import { config as loadEnv } from "dotenv";

loadEnv({ path: path.resolve(__dirname, "../../../.env"), quiet: true });

import express from "express";
import { timingSafeEqual } from "node:crypto";
import {
  forgetPlugin,
  listInstalledKeys,
  loadBuiltinPlugin,
  loadOperatorPlugin,
  loadSignedPlugin,
} from "./registry";
import { runPlugin } from "./sandbox/runner";

/**
 * The plugin execution service.
 *
 * It runs as its own process — its own container in production — and that is the
 * point: it holds no database credentials, no S3 keys and no admin session. The
 * only secret it carries is the internal token it shares with cms-api, plus the
 * short-lived scoped tokens cms-api mints per invocation.
 *
 * Even a total compromise of this service therefore yields exactly the
 * privileges the installed plugins were granted, and nothing more.
 */

const app = express();
app.use(express.json({ limit: "1mb" }));

const INTERNAL_TOKEN = () => process.env.CMS_INTERNAL_TOKEN ?? "";

app.use((req, res, next) => {
  if (req.path === "/health") return next();

  const expected = INTERNAL_TOKEN();
  const provided = String(req.headers["x-internal-token"] ?? "");
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);

  if (!expected || a.length !== b.length || !timingSafeEqual(a, b)) {
    res.status(401).json({ message: "Invalid internal token." });
    return;
  }
  next();
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "plugin-runtime", plugins: listInstalledKeys() });
});

/**
 * Executes one hook of one plugin, for one site.
 *
 * Note what the body does NOT contain: plugin code. cms-api sends a key; the
 * runtime resolves it against its own verified bundle directory. A compromised
 * API cannot use this endpoint to run arbitrary JavaScript.
 */
/**
 * Drops a revoked plugin from this runtime's caches.
 *
 * Internal-token guarded. Note what the API can and cannot do with it: it can
 * only make the runtime FORGET code. Making it *run* code still requires a
 * marketplace signature the API does not hold the key for.
 */
app.post("/purge", (req, res) => {
  const { key, version } = req.body as { key?: string; version?: string };
  if (!key || !version) {
    res.status(400).json({ message: "key and version are required." });
    return;
  }

  forgetPlugin(key, version);
  console.warn(`[purge] ${key}@${version} revoked — cache dropped`);
  res.json({ purged: true });
});

app.post("/execute", async (req, res) => {
  const { pluginKey, version, trust, invocation, settings, secrets, site, pluginToken } =
    req.body as {
      pluginKey?: string;
      version?: string;
      /** Which trust route loads this plugin — see PluginTrust in cms-api. */
      trust?: "builtin" | "marketplace" | "operator";
      invocation?: { kind: "action" | "job" | "call" | "filter" | "setup"; name?: string };
      settings?: Record<string, unknown>;
      /** Which declared secrets are configured. Booleans; cms-api never sends values. */
      secrets?: Record<string, boolean>;
      site?: { id: string; name: string; locale: string };
      pluginToken?: string;
    };

  if (!pluginKey || !invocation?.kind || !site?.id || !pluginToken) {
    res.status(400).json({ message: "Missing pluginKey, invocation, site or pluginToken." });
    return;
  }

  let code: string;
  try {
    // Three trust routes, one per pinned key — and cms-api names the route, the
    // runtime does not guess it from the bundle. Each downloads or reads bytes and
    // verifies them against a DIFFERENT key held in THIS process's config:
    //   marketplace → the pinned MARKETPLACE key (reviewed community code);
    //   operator    → the pinned OPERATOR key (this instance's own sideload);
    //   builtin     → the pinned FIRST-PARTY key, read from PLUGIN_DIR.
    // None of them reads a loose .js file off the volume, and none falls back to
    // another route's key. An unknown trust value is refused rather than defaulted.
    switch (trust ?? "builtin") {
      case "marketplace":
        code = await loadSignedPlugin(pluginKey, version ?? "0.0.0");
        break;
      case "operator":
        code = await loadOperatorPlugin(pluginKey, version ?? "0.0.0");
        break;
      case "builtin":
        code = (await loadBuiltinPlugin(pluginKey)).code;
        break;
      default:
        res.status(400).json({ message: `Unknown trust route "${trust}".` });
        return;
    }
  } catch (err) {
    res.status(404).json({ message: (err as Error).message });
    return;
  }

  const result = await runPlugin({
    pluginKey,
    code,
    invocation: invocation as never,
    settings: settings ?? {},
    secrets: secrets ?? {},
    site,
    pluginToken,
  });

  for (const line of result.logs) {
    console.log(`[plugin:${pluginKey}] ${line.level}: ${line.message}`);
  }

  if (!result.ok) {
    console.warn(`[plugin:${pluginKey}] failed in ${result.durationMs}ms: ${result.error}`);
  }

  // A failed plugin is reported, never thrown: cms-api decides what to do about
  // it (log it, disable the plugin), and a publish must not fail because someone
  // installed a broken SEO plugin.
  res.json({
    ok: result.ok,
    result: result.result,
    error: result.error,
    durationMs: result.durationMs,
  });
});

const port = Number(process.env.PLUGIN_RUNTIME_PORT ?? 4200);
app.listen(port, () => {
  console.log(`plugin-runtime listening on http://localhost:${port}`);
  console.log(`plugins available: ${listInstalledKeys().join(", ") || "(none)"}`);
});
