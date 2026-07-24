import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { getT } from "@/lib/locale";
import { describeStatus } from "@/lib/plugin-permissions";

/**
 * Which plugins may send mail as this site.
 *
 * The consent screen asked this question once, at install, and then the answer
 * disappeared into a row in a table. But "which of these things can email my
 * customers?" is not a question that gets asked once — it gets asked the morning
 * someone forwards you a message they did not expect, and the place they will
 * look for the answer is the mail settings page.
 */
export async function MailSenders({
  senders,
}: {
  senders: { key: string; name: string; status: string | null }[];
}) {
  const t = await getT();

  return (
    <section className="z-card mt-4 p-5">
      <h2 className="text-sm font-semibold">{t("mail.plugins.legend")}</h2>

      {senders.length === 0 ? (
        <p className="mt-2 text-xs z-muted">{t("mail.plugins.none")}</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {senders.map((sender) => {
            const status = describeStatus(sender.status, true, t);
            return (
              <li
                key={sender.key}
                className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{sender.name}</p>
                  <p className="truncate font-mono text-[11px] z-muted">{sender.key}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge tone={status.tone}>{status.label}</Badge>
                  <Link href="/plugins" className="text-xs underline underline-offset-2">
                    {t("mail.plugins.manage")}
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="mt-3 text-[11px] leading-4 z-muted">
        {t("mail.plugins.quota", { limit: "200" })}
      </p>
    </section>
  );
}
