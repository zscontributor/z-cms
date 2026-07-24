import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import type { InvitationDto, SiteDto, UserDto } from "@zcmsorg/schemas";
import { can, getSession, listInvitations, listSites, listUsers } from "@/lib/api";
import { getLocale, getT } from "@/lib/locale";
import { PageHeader } from "@/components/page-header";
import { InviteForm } from "./invite-form";
import { PendingInvitations } from "./pending-invitations";
import { UsersTable } from "./users-table";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("admin.users.metaTitle") };
}

export const dynamic = "force-dynamic";

/**
 * Who has access, and as what.
 *
 * Three permissions, three different screens out of one page: `user:read` shows
 * the table (ADMIN and OWNER), `user:invite` adds the invite panel (ADMIN and
 * OWNER), `user:manage` unlocks the row actions (OWNER only). An ADMIN can
 * therefore see the team and grow it but not demote or remove anyone — which is
 * the shape ROLE_PERMISSIONS has always described, and this is the first screen
 * that actually honours it.
 */
export default async function UsersPage() {
  const t = await getT();
  const locale = await getLocale();
  const user = await getSession();
  if (!user) redirect("/login");

  // A 404 rather than a "you may not see this": the page is not a thing that
  // exists-but-is-closed to a VIEWER, and the nav does not offer it to them.
  if (!can(user, "user:read")) notFound();

  const mayInvite = can(user, "user:invite");
  const mayManage = can(user, "user:manage");

  const [users, invitations, sites] = await Promise.all([
    safe<UserDto[]>(listUsers, []),
    mayInvite ? safe<InvitationDto[]>(listInvitations, []) : Promise.resolve<InvitationDto[]>([]),
    safe<SiteDto[]>(listSites, []),
  ]);

  return (
    <>
      <PageHeader title={t("admin.users.title")} description={t("admin.users.description")} />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="min-w-0">
          <UsersTable
            users={users}
            sites={sites}
            currentUserId={user.id}
            canManage={mayManage}
            locale={locale}
          />
        </div>

        {mayInvite ? (
          <div className="flex flex-col gap-6">
            <section>
              <h2 className="text-sm font-semibold">{t("admin.users.invite.heading")}</h2>
              <p className="mt-0.5 mb-3 text-xs z-muted">{t("admin.users.invite.description")}</p>
              <InviteForm sites={sites} />
            </section>

            <section>
              <h2 className="text-sm font-semibold">{t("admin.users.pending.heading")}</h2>
              <p className="mt-0.5 mb-3 text-xs z-muted">{t("admin.users.pending.description")}</p>
              <PendingInvitations invitations={invitations} locale={locale} />
            </section>
          </div>
        ) : null}
      </div>
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
