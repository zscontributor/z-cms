import type { Metadata } from "next";
import type { MailSettingsDto } from "@zcmsorg/schemas";
import { can, getMailSettings, getSession, listPlugins } from "@/lib/api";
import { getLocale, getT } from "@/lib/locale";
import { PageHeader } from "@/components/page-header";
import { MailSettingsForm } from "./mail-settings-form";
import { MailSenders } from "./mail-senders";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("mail.metaTitle") };
}

export const dynamic = "force-dynamic";

/**
 * Settings → Mail.
 *
 * Reading is `settings:read`, changing is `settings:update`, and *sending* is
 * `mail:send` — three permissions on one screen, because they are three different
 * risks. The form is rendered disabled rather than hidden for a reader: seeing
 * which server the site sends through is how someone diagnoses a missing email,
 * and they should not need the right to break it in order to look.
 */
export default async function MailSettingsPage() {
  const t = await getT();
  const locale = await getLocale();
  const user = await getSession();

  if (!can(user, "settings:read")) {
    return <div className="z-card p-10 text-center text-sm">{t("mail.denied")}</div>;
  }

  const [settings, plugins] = await Promise.all([
    safe<MailSettingsDto | null>(getMailSettings, null),
    // The list of plugins that hold mail:send. Not decoration: "which plugin sent
    // that email?" is the first question anyone asks about mail they did not
    // expect, and it is answerable from data this page already has.
    safe(listPlugins, []),
  ]);

  if (!settings) {
    return <div className="z-card p-10 text-center text-sm">{t("mail.actions.saveFailed")}</div>;
  }

  const canConfigure = can(user, "settings:update");
  const canSend = can(user, "mail:send");

  const senders = plugins
    .filter((plugin) => plugin.installed && plugin.grantedPermissions?.includes("mail:send"))
    .map((plugin) => ({ key: plugin.key, name: plugin.name, status: plugin.status }));

  return (
    <>
      <PageHeader title={t("mail.title")} description={t("mail.description")} />

      {!canConfigure ? (
        <p className="mb-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3 text-sm z-muted">
          {t("mail.readOnly")}
        </p>
      ) : null}

      <MailSettingsForm
        settings={settings}
        locale={locale}
        canConfigure={canConfigure}
        canSend={canSend}
      />

      <MailSenders senders={senders} />
    </>
  );
}

/** An unreachable API must not take the screen down with it. */
async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}
