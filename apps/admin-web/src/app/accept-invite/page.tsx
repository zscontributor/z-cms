import type { Metadata } from "next";
import { Logo } from "@/components/brand";
import { getT } from "@/lib/locale";
import { AcceptInviteForm } from "./accept-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("auth.acceptInvite.metaTitle") };
}

/**
 * The one screen someone reaches before they have an account.
 *
 * It deliberately does NOT look the invitation up server-side to show who sent it
 * or what role it carries. That would need a public endpoint taking a token and
 * answering with details about a tenant — which is an oracle: feed it guesses and
 * it tells you which ones are real, for free, before anyone has to commit to a
 * password. The token is redeemed or it is not, and the answer is the same either
 * way.
 */
export default async function AcceptInvitePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const t = await getT();
  const { token } = await searchParams;

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <Logo size={40} />
          <div>
            <h1 className="text-lg font-semibold tracking-tight">{t("auth.acceptInvite.title")}</h1>
            <p className="mt-1 text-xs z-muted">{t("auth.acceptInvite.subtitle", { tenant: "Z-CMS" })}</p>
          </div>
        </div>

        <div className="z-card p-6 shadow-sm">
          {token ? (
            <AcceptInviteForm token={token} />
          ) : (
            <div className="flex flex-col gap-2 text-center">
              <p className="text-sm font-medium">{t("auth.acceptInvite.invalidTitle")}</p>
              <p className="text-xs leading-5 z-muted">{t("auth.acceptInvite.invalidBody")}</p>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
