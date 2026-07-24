"use client";

import { useState, useTransition } from "react";
import type { InvitationDto } from "@zcmsorg/schemas";
import { revokeInvitationAction } from "@/app/actions/user";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/table";
import { formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n-provider";

/**
 * Invitations sent and not yet answered.
 *
 * Deliberately does not offer to "resend" or "show the link again": the token is
 * stored only as a hash, so neither is possible — and a button that appeared to
 * do it would be a lie about how the invitation is protected. Withdrawing and
 * inviting afresh is the honest path, and it is one click.
 */
export function PendingInvitations({
  invitations,
  locale,
}: {
  invitations: InvitationDto[];
  locale: string;
}) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  function revoke(id: string) {
    setError(null);
    setPendingId(id);
    startTransition(async () => {
      const result = await revokeInvitationAction(id);
      if (!result.ok) setError(result.error);
      setPendingId(null);
    });
  }

  if (invitations.length === 0) {
    return (
      <div className="z-card">
        <EmptyState title={t("admin.users.pending.emptyTitle")} />
      </div>
    );
  }

  return (
    <>
      {error ? (
        <p
          role="alert"
          className="mb-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
        >
          {error}
        </p>
      ) : null}

      <ul className="flex flex-col gap-2">
        {invitations.map((invitation) => (
          <li key={invitation.id}>
            <article className="z-card flex flex-wrap items-start justify-between gap-2 p-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{invitation.email}</p>
                <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] z-muted">
                  <Badge>
                    {t(`admin.roles.${invitation.role}`)}
                    <span className="ml-1 font-normal opacity-70">
                      · {invitation.siteName ?? t("admin.users.tenantWide")}
                    </span>
                  </Badge>
                  <span>{t("admin.users.pending.expires", {
                    date: formatDateTime(invitation.expiresAt, locale),
                  })}</span>
                </p>
                {invitation.invitedByName ? (
                  <p className="mt-0.5 text-[11px] z-muted">
                    {t("admin.users.pending.invitedBy", { name: invitation.invitedByName })}
                  </p>
                ) : null}
              </div>

              <Button
                size="sm"
                variant="danger"
                disabled={busy}
                onClick={() => revoke(invitation.id)}
              >
                {busy && pendingId === invitation.id
                  ? t("common.working")
                  : t("admin.users.pending.revoke")}
              </Button>
            </article>
          </li>
        ))}
      </ul>
    </>
  );
}
