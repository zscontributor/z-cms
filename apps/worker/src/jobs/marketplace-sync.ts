/**
 * Asks cms-api to pull and enforce the marketplace's revocation list.
 *
 * The worker is the clock, not the brain — the same split as `plugin.deferred`.
 * Verifying the list means holding the pinned marketplace public key, and acting
 * on it means moving sites off a theme and quarantining plugins; both belong to
 * cms-api, which already owns that machinery and is already the only process
 * allowed to decide what a site runs. Duplicating it here would be a second
 * revocation path, and the second path is always the one that rots.
 *
 * Failure is deliberately quiet-but-recorded. This job runs hourly and the
 * marketplace will sometimes be down; throwing would fill the dead-letter queue
 * with noise that resolves itself. cms-api records the failure, and the age of
 * the last good sync is what the admin surfaces — a channel that has been silent
 * for a day is the alarm, not a single missed tick.
 */
export async function runMarketplaceSync(): Promise<{
  ok: boolean;
  applied: number;
  error?: string;
}> {
  const apiUrl = (process.env.CMS_API_URL ?? "http://localhost:4100").replace(/\/+$/, "");

  const res = await fetch(`${apiUrl}/api/v1/marketplace/sync`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-token": process.env.CMS_INTERNAL_TOKEN ?? "",
    },
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    // cms-api itself being unreachable IS worth a retry — that is our own process,
    // not the internet.
    throw new Error(`marketplace.sync: HTTP ${res.status} ${await res.text()}`);
  }

  return (await res.json()) as { ok: boolean; applied: number; error?: string };
}
