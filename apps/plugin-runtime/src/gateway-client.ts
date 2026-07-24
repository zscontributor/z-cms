/**
 * The one door out of the sandbox.
 *
 * Plugin code never has a socket, a database handle or a token. It posts an RPC
 * message; this module turns that into a call to cms-api's plugin gateway,
 * carrying the plugin's scoped token. cms-api then decides — again, from the
 * token, not from anything the plugin said — whether that plugin is allowed to
 * do that thing on that site.
 *
 * The scope check therefore happens on the far side of the trust boundary. A
 * plugin that patched out a local check would gain nothing.
 */

const CMS_API_URL = () =>
  (process.env.CMS_API_URL ?? "http://localhost:4100").replace(/\/+$/, "");

/** Calls a plugin gateway method with the plugin's own token. */
export async function callGateway(
  pluginToken: string,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`${CMS_API_URL()}/api/v1/plugin-gateway/call`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${pluginToken}`,
    },
    body: JSON.stringify({ method, params }),
    signal: AbortSignal.timeout(3000),
  });

  const body = (await res.json().catch(() => ({}))) as {
    data?: unknown;
    message?: string;
  };

  if (!res.ok) {
    throw new Error(body.message ?? `Gateway rejected ${method} (HTTP ${res.status}).`);
  }

  return body.data;
}
