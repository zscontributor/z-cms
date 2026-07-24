import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { UserDto } from "@zcmsorg/schemas";
import { getSession, listUsers } from "@/lib/api";
import { getT } from "@/lib/locale";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/page-header";
import { PasswordForm } from "./password-form";
import { ProfileForm } from "./profile-form";
import { TwoFactorPanel } from "./two-factor-panel";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("admin.profile.metaTitle") };
}

export const dynamic = "force-dynamic";

/**
 * Your own account. No permission gates anything here — a VIEWER who could not
 * change their own password would have to ask an admin to do it for them, which
 * is the opposite of what a password is for.
 */
export default async function ProfilePage() {
  const t = await getT();
  const user = await getSession();
  if (!user) redirect("/login");

  // /auth/me answers with the session (identity + effective permissions), not
  // with the membership rows. Reading them from /users needs `user:read`, which
  // an AUTHOR does not have — so this is best-effort, and its absence costs only
  // the "your access" panel, never the forms.
  const me = await mine(user.id);

  return (
    <>
      <PageHeader title={t("admin.profile.title")} description={t("admin.profile.description")} />

      <div className="grid max-w-4xl gap-6 lg:grid-cols-2">
        <section>
          <h2 className="text-sm font-semibold">{t("admin.profile.details.heading")}</h2>
          <p className="mt-0.5 mb-3 text-xs z-muted">{t("admin.profile.details.emailHint")}</p>
          <ProfileForm
            email={user.email}
            name={user.name}
            avatarUrl={user.avatarUrl}
          />
        </section>

        <section className="flex flex-col gap-6">
          <div>
            <h2 className="text-sm font-semibold">{t("admin.profile.password.heading")}</h2>
            <p className="mt-0.5 mb-3 text-xs z-muted">
              {t("admin.profile.password.description")}
            </p>
            <PasswordForm />
          </div>

          {/* The one control on this page that survives a stolen password. */}
          <TwoFactorPanel enabled={user.twoFactorEnabled} />
        </section>
      </div>

      {me && me.memberships.length > 0 ? (
        <section className="mt-8 max-w-4xl">
          <h2 className="text-sm font-semibold">{t("admin.profile.roles.heading")}</h2>
          <p className="mt-0.5 mb-3 text-xs z-muted">{t("admin.profile.roles.description")}</p>
          <ul className="flex flex-wrap gap-2">
            {me.memberships.map((membership) => (
              <li key={membership.id}>
                <Badge tone={membership.role === "OWNER" ? "warning" : "info"}>
                  {t(`admin.roles.${membership.role}`)}
                  <span className="ml-1 font-normal opacity-70">
                    · {membership.siteName ?? t("admin.users.tenantWide")}
                  </span>
                </Badge>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

async function mine(userId: string): Promise<UserDto | null> {
  try {
    const users = await listUsers();
    return users.find((user) => user.id === userId) ?? null;
  } catch {
    return null;
  }
}
