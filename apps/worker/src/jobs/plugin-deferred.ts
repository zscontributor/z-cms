import type { JobPayloads } from "@zcmsorg/queue";

/**
 * Runs a plugin's deferred job — by NOT running it here.
 *
 * The worker holds database and S3 credentials, so it is the last place a
 * plugin's code should execute. Instead it calls an internal cms-api endpoint,
 * which mints the plugin's scoped token and dispatches the job into the
 * isolated-vm sandbox exactly like a live hook. The plugin runs where plugin
 * code always runs; the worker only pulls the trigger.
 *
 * So `ctx.jobs.enqueue("rebuild-index", {...})` grants a plugin nothing new: it
 * is the same sandbox, the same scopes, the same gateway — just later, and
 * durably (BullMQ retries it if the run fails).
 */
export async function runPluginDeferred(
  data: JobPayloads["plugin.deferred"],
): Promise<{ ok: boolean; error?: string }> {
  const apiUrl = (process.env.CMS_API_URL ?? "http://localhost:4100").replace(/\/+$/, "");

  const res = await fetch(`${apiUrl}/api/v1/plugin-gateway/run-job`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-token": process.env.CMS_INTERNAL_TOKEN ?? "",
    },
    body: JSON.stringify({
      tenantId: data.tenantId,
      siteId: data.siteId,
      pluginKey: data.pluginKey,
      name: data.name,
      payload: data.payload,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    // Throwing marks the BullMQ job failed, so it retries with backoff. A plugin
    // that is temporarily failing gets another chance; one that always fails
    // exhausts its attempts and lands in the failed set for inspection.
    const body = await res.text();
    throw new Error(`plugin.deferred ${data.pluginKey}/${data.name}: HTTP ${res.status} ${body}`);
  }

  return (await res.json()) as { ok: boolean; error?: string };
}
