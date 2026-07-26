import { promises as dns } from "node:dns";

/**
 * Every REPLICA of an internal runtime, as base URLs to broadcast to.
 *
 * A Docker Swarm service name (`z-cms_site-runtime`) is a VIP: one connection
 * load-balances to ONE task. For a broadcast that is exactly wrong — dropping a
 * cache each replica holds INDEPENDENTLY (site-runtime's per-replica Next.js ISR
 * cache, a verified-bundle cache, …). A purge that lands on one task leaves every
 * other task serving the stale copy until its own TTL: the "why does it take a
 * minute for the new theme to show" problem, and it gets worse with more replicas.
 *
 * Docker also publishes `tasks.<service>`, which resolves to ALL task IPs. We fan
 * the broadcast out to each so a purge reaches every replica in one shot.
 *
 * Falls back to the URL as-is when `tasks.<host>` does not resolve — a single
 * instance, local dev, or a public FQDN (an API-only deploy pointed at one origin).
 * So it is safe everywhere and simply does nothing extra when there is nothing to
 * fan out to.
 */
export async function serviceReplicaBases(baseUrl: string): Promise<string[]> {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return [baseUrl];
  }

  // An IP or a public FQDN has no `tasks.` sibling; only a Swarm VIP short-name
  // does. `dns.resolve4` asks Docker's embedded DNS (127.0.0.11) for the task set.
  try {
    const ips = await dns.resolve4(`tasks.${parsed.hostname}`);
    if (ips.length === 0) return [baseUrl];
    const port = parsed.port ? `:${parsed.port}` : "";
    return ips.map((ip) => `${parsed.protocol}//${ip}${port}`);
  } catch {
    return [baseUrl];
  }
}
