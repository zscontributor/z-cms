import type { JobPayloads } from "@zcmsorg/queue";

/**
 * Delivers a queued email — by NOT delivering it here.
 *
 * The same shape as `plugin.deferred`, for the same reason. The worker's job is to
 * remember and to retry; it is not the place that should hold a decryption key or
 * open an authenticated SMTP session. It calls an internal cms-api endpoint, which
 * owns MAIL_ENCRYPTION_KEY, resolves the site's configuration, runs the
 * `mail.sending` plugin filter and talks to the mail server.
 *
 * So the worker never learns the SMTP password, and a compromised worker cannot
 * send mail as the site — it can only ask cms-api to, which is precisely what the
 * queue is for. What the worker adds is durability: a mail server that is down at
 * 09:00 is usually up at 09:05, and BullMQ's exponential backoff is what turns
 * that from a lost email into a late one.
 */
export async function runMailSend(data: JobPayloads["mail.send"]): Promise<unknown> {
  const res = await call("deliver", {
    tenantId: data.tenantId,
    siteId: data.siteId,
    message: data.message,
    pluginKey: data.pluginKey,
  });

  if (!res.ok) {
    // Throwing marks the BullMQ job failed, so it retries with backoff. A mail
    // server that is temporarily refusing gets another chance; one that always
    // refuses exhausts its attempts and reaches `reportMailDeadLetter` below.
    throw new Error(`mail.send to ${data.message.to.join(", ")}: HTTP ${res.status} ${res.body}`);
  }

  return res.body;
}

/**
 * The mail is never going to arrive. Tell cms-api, so it can fire `mail.failed`.
 *
 * Called from the worker's `failed` listener only when the retries are exhausted.
 * A plugin that subscribes to `mail.failed` is building a suppression list or a
 * bounce report; an event that fired on attempt one of three — while the mail was
 * still very likely to go out — would make both of those wrong.
 *
 * Best-effort by construction: this runs *because* something already failed, and
 * a dead letter that also fails to be reported must not crash the worker on its
 * way out. The dead-letter alert in main.ts is the backstop that still fires.
 */
export async function reportMailDeadLetter(
  data: JobPayloads["mail.send"],
  error: string,
): Promise<void> {
  try {
    const res = await call("dead-letter", { ...data, error });
    if (!res.ok) {
      console.error(`[worker] mail dead-letter report rejected: HTTP ${res.status} ${res.body}`);
    }
  } catch (err) {
    console.error(`[worker] mail dead-letter report failed: ${(err as Error).message}`);
  }
}

async function call(
  path: "deliver" | "dead-letter",
  body: unknown,
): Promise<{ ok: boolean; status: number; body: string }> {
  const apiUrl = (process.env.CMS_API_URL ?? "http://localhost:4100").replace(/\/+$/, "");

  const res = await fetch(`${apiUrl}/api/v1/mail/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-token": process.env.CMS_INTERNAL_TOKEN ?? "",
    },
    body: JSON.stringify(body),
    // Generous, because the SMTP conversation happens on the far side of it: the
    // API's own socket timeout is 30s, and a deadline shorter than that would
    // retry a mail that is, at this instant, still being delivered.
    signal: AbortSignal.timeout(45_000),
  });

  return { ok: res.ok, status: res.status, body: await res.text() };
}
