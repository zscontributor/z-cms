import type { Metadata } from "next";
import type { CommerceSettingsDto } from "@zcmsorg/schemas";
import { can, getCommerceSettings, getSession } from "@/lib/api";
import { getLocale, getT } from "@/lib/locale";
import { PageHeader } from "@/components/page-header";
import { CommerceSettingsForm } from "./commerce-settings-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("commerce.settings.metaTitle") };
}

export const dynamic = "force-dynamic";

/**
 * Settings → Storefront. Reading needs `order:read`; changing needs
 * `commerce:configure`, and the form renders disabled without it — the same
 * read-only-for-viewers shape as the mail settings screen.
 */
export default async function CommerceSettingsPage() {
  const t = await getT();
  const locale = await getLocale();
  const user = await getSession();

  if (!can(user, "order:read")) {
    return <div className="z-card p-10 text-center text-sm">{t("commerce.settings.denied")}</div>;
  }

  let settings: CommerceSettingsDto;
  try {
    settings = await getCommerceSettings();
  } catch {
    return <div className="z-card p-10 text-center text-sm">{t("commerce.settings.saveFailed")}</div>;
  }

  const canConfigure = can(user, "commerce:configure");

  return (
    <>
      <PageHeader
        title={t("commerce.settings.title")}
        description={t("commerce.settings.description")}
      />
      {!canConfigure ? (
        <p className="mb-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3 text-sm z-muted">
          {t("commerce.settings.readOnly")}
        </p>
      ) : null}
      <CommerceSettingsForm settings={settings} disabled={!canConfigure} locale={locale} />
    </>
  );
}
