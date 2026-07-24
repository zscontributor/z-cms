"use client";

import { useState, useTransition } from "react";
import { ROLES, type MembershipDto, type Role, type SiteDto, type UserDto } from "@zcmsorg/schemas";
import {
  removeMembershipAction,
  removeUserAction,
  resetTwoFactorAction,
  setMembershipAction,
  updateUserAction,
} from "@/app/actions/user";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { EmptyState, Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Icon } from "@/components/shell/icon";
import { formatDateTime } from "@/lib/format";
import type { BadgeTone } from "@/lib/format";
import { useT } from "@/lib/i18n-provider";

/**
 * OWNER is the only role coloured as a warning, and it is not decoration: it is
 * the role that can delete the site and hand out its own power, so a table where
 * it looks like every other badge is a table that hides the only row that matters.
 */
const ROLE_TONES: Record<Role, BadgeTone> = {
  OWNER: "warning",
  ADMIN: "info",
  EDITOR: "neutral",
  AUTHOR: "neutral",
  VIEWER: "neutral",
};

type Pending =
  | { kind: "edit"; user: UserDto }
  | { kind: "role"; user: UserDto }
  | { kind: "removeUser"; user: UserDto }
  | { kind: "removeRole"; user: UserDto; membership: MembershipDto }
  | { kind: "resetTwoFactor"; user: UserDto }
  | null;

export function UsersTable({
  users,
  sites,
  currentUserId,
  canManage,
  locale,
}: {
  users: UserDto[];
  sites: SiteDto[];
  currentUserId: string;
  canManage: boolean;
  locale: string;
}) {
  const t = useT();
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  // The role dialog's two fields. Seeded when it opens, so reopening on a
  // different user does not carry the previous one's answers over.
  const [role, setRole] = useState<Role>("VIEWER");
  const [scope, setScope] = useState<string>("");
  const [editName, setEditName] = useState("");
  const [editAvatarUrl, setEditAvatarUrl] = useState("");

  function open(next: Pending) {
    setError(null);
    setNotice(null);
    if (next?.kind === "edit") {
      setEditName(next.user.name);
      setEditAvatarUrl(next.user.avatarUrl ?? "");
    }
    if (next?.kind === "role") {
      const existing = next.user.memberships[0];
      setRole((existing?.role as Role) ?? "VIEWER");
      setScope(existing?.siteId ?? "");
    }
    setPending(next);
  }

  function run(action: () => Promise<{ ok: true; message: string } | { ok: false; error: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        // The API's own sentence — "this is the last owner", "you cannot grant
        // OWNER" — is the whole value of the failure. Shown verbatim.
        setError(result.error);
        return;
      }
      setPending(null);
      setNotice(result.message);
    });
  }

  const scopeLabel = (membership: MembershipDto) =>
    membership.siteName ?? t("admin.users.tenantWide");

  if (users.length === 0) {
    return (
      <Table>
        <TBody>
          <TR>
            <TD>
              <EmptyState
                title={t("admin.users.emptyTitle")}
                description={t("admin.users.emptyDescription")}
              />
            </TD>
          </TR>
        </TBody>
      </Table>
    );
  }

  return (
    <>
      {notice ? (
        <p
          role="status"
          className="mb-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"
        >
          {notice}
        </p>
      ) : null}

      {error && pending === null ? (
        <p
          role="alert"
          className="mb-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
        >
          {error}
        </p>
      ) : null}

      <Table>
        <THead>
          <TR>
            <TH>{t("admin.users.columns.user")}</TH>
            <TH>{t("admin.users.columns.roles")}</TH>
            <TH>{t("admin.users.columns.lastLogin")}</TH>
            <TH className="w-0" />
          </TR>
        </THead>
        <TBody>
          {users.map((user) => {
            const isSelf = user.id === currentUserId;
            // Rule 3 lives in the API; this only stops the UI offering a button
            // whose only possible outcome is a 403.
            const actionable = canManage && !isSelf;

            return (
              <TR key={user.id}>
                <TD>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">{user.name}</span>
                    {isSelf ? <Badge tone="info">{t("admin.users.you")}</Badge> : null}
                    {/* Shown for BOTH states, not just the good one. A column that
                        only marks the protected accounts leaves the unprotected
                        ones looking like the default, which is the opposite of
                        what an administrator needs to see. */}
                    <Badge tone={user.twoFactorEnabled ? "success" : "warning"}>
                      <Icon
                        name={user.twoFactorEnabled ? "shield" : "warning"}
                        size={12}
                        className="mr-0.5"
                      />
                      {user.twoFactorEnabled
                        ? t("admin.users.twoFactor.on")
                        : t("admin.users.twoFactor.off")}
                    </Badge>
                  </div>
                  <p className="text-[11px] z-muted">{user.email}</p>
                </TD>

                <TD>
                  {user.memberships.length === 0 ? (
                    <span className="text-[11px] z-muted">{t("admin.users.noRoles")}</span>
                  ) : (
                    <ul className="flex flex-wrap gap-1.5">
                      {user.memberships.map((membership) => (
                        <li key={membership.id} className="flex items-center gap-1">
                          <Badge tone={ROLE_TONES[membership.role]}>
                            {t(`admin.roles.${membership.role}`)}
                            <span className="ml-1 font-normal opacity-70">
                              · {scopeLabel(membership)}
                            </span>
                          </Badge>
                          {actionable ? (
                            <button
                              type="button"
                              disabled={busy}
                              title={t("admin.users.removeRole")}
                              aria-label={t("admin.users.removeRole")}
                              onClick={() => open({ kind: "removeRole", user, membership })}
                              className="rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--surface-sunken)] hover:text-red-600 disabled:opacity-50 dark:hover:text-red-400"
                            >
                              <Icon name="trash" size={13} />
                            </button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </TD>

                <TD className="whitespace-nowrap text-xs z-muted">
                  {user.lastLoginAt ? formatDateTime(user.lastLoginAt, locale) : t("admin.users.never")}
                </TD>

                <TD>
                  {actionable ? (
                    <div className="flex justify-end gap-1.5">
                      <Button
                        size="sm"
                        disabled={busy}
                        title={t("admin.users.edit.button")}
                        aria-label={t("admin.users.edit.button")}
                        onClick={() => open({ kind: "edit", user })}
                      >
                        <Icon name="edit" size={15} />
                      </Button>
                      {user.twoFactorEnabled ? (
                        <Button
                          size="sm"
                          disabled={busy}
                          title={t("admin.users.resetTwoFactor")}
                          aria-label={t("admin.users.resetTwoFactor")}
                          onClick={() => open({ kind: "resetTwoFactor", user })}
                        >
                          <Icon name="key" size={15} />
                        </Button>
                      ) : null}
                      <Button size="sm" disabled={busy} onClick={() => open({ kind: "role", user })}>
                        <Icon name="shield" size={15} />
                        {t("admin.users.changeRole")}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={busy}
                        title={t("admin.users.remove")}
                        aria-label={t("admin.users.remove")}
                        onClick={() => open({ kind: "removeUser", user })}
                      >
                        <Icon name="trash" size={15} />
                      </Button>
                    </div>
                  ) : null}
                </TD>
              </TR>
            );
          })}
        </TBody>
      </Table>

      <Dialog
        open={pending?.kind === "edit"}
        onClose={busy ? () => undefined : () => setPending(null)}
        title={t("admin.users.edit.title", { name: pending?.user.name ?? "" })}
        footer={
          <>
            <Button type="button" disabled={busy} onClick={() => setPending(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={busy}
              onClick={() =>
                pending?.kind === "edit" &&
                run(() =>
                  updateUserAction(pending.user.id, {
                    name: editName,
                    avatarUrl: editAvatarUrl,
                  }),
                )
              }
            >
              {busy ? t("common.working") : t("admin.users.edit.submit")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label={t("admin.users.edit.name")} htmlFor="edit-user-name" required>
            <Input
              id="edit-user-name"
              value={editName}
              disabled={busy}
              onChange={(event) => setEditName(event.target.value)}
            />
          </Field>

          <Field label={t("admin.users.edit.avatarUrl")} htmlFor="edit-user-avatar">
            <Input
              id="edit-user-avatar"
              value={editAvatarUrl}
              disabled={busy}
              onChange={(event) => setEditAvatarUrl(event.target.value)}
              placeholder="https://..."
            />
          </Field>

          {error ? <DialogError message={error} /> : null}
        </div>
      </Dialog>

      <Dialog
        open={pending?.kind === "role"}
        onClose={busy ? () => undefined : () => setPending(null)}
        title={t("admin.users.role.title", { name: pending?.user.name ?? "" })}
        footer={
          <>
            <Button type="button" disabled={busy} onClick={() => setPending(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={busy}
              onClick={() =>
                pending?.kind === "role" &&
                run(() => setMembershipAction(pending.user.id, role, scope || null))
              }
            >
              {busy ? t("common.working") : t("admin.users.role.submit")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-xs leading-5">{t("admin.users.role.body")}</p>

          <Field
            label={t("admin.users.role.scope")}
            hint={t("admin.users.role.scopeHint")}
            htmlFor="role-scope"
          >
            <Select
              id="role-scope"
              value={scope}
              disabled={busy}
              onChange={(event) => setScope(event.target.value)}
            >
              <option value="">{t("admin.users.tenantWide")}</option>
              {sites.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={t("admin.users.role.role")} htmlFor="role-role">
            <Select
              id="role-role"
              value={role}
              disabled={busy}
              onChange={(event) => setRole(event.target.value as Role)}
            >
              {ROLES.map((value) => (
                <option key={value} value={value}>
                  {t(`admin.roles.${value}`)}
                </option>
              ))}
            </Select>
          </Field>

          {error ? <DialogError message={error} /> : null}
        </div>
      </Dialog>

      <Dialog
        open={pending?.kind === "removeRole"}
        onClose={busy ? () => undefined : () => setPending(null)}
        title={
          pending?.kind === "removeRole"
            ? t("admin.users.removeRoleDialog.title", {
                role: t(`admin.roles.${pending.membership.role}`),
                scope: scopeLabel(pending.membership),
              })
            : ""
        }
        footer={
          <>
            <Button type="button" disabled={busy} onClick={() => setPending(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() =>
                pending?.kind === "removeRole" &&
                run(() => removeMembershipAction(pending.user.id, pending.membership.id))
              }
            >
              {busy ? t("common.working") : t("admin.users.removeRoleDialog.confirm")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-xs leading-5">{t("admin.users.removeRoleDialog.body")}</p>
          {error ? <DialogError message={error} /> : null}
        </div>
      </Dialog>

      {/* Resetting someone's 2FA leaves their account defended by a password
          alone. The dialog says that in as many words: an admin who does not know
          what they just took away cannot weigh whether to take it. */}
      <Dialog
        open={pending?.kind === "resetTwoFactor"}
        onClose={busy ? () => undefined : () => setPending(null)}
        title={t("admin.users.resetTwoFactorDialog.title", { name: pending?.user.name ?? "" })}
        footer={
          <>
            <Button type="button" disabled={busy} onClick={() => setPending(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() =>
                pending?.kind === "resetTwoFactor" &&
                run(() => resetTwoFactorAction(pending.user.id, pending.user.name))
              }
            >
              {busy ? t("common.working") : t("admin.users.resetTwoFactorDialog.confirm")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-xs leading-5">{t("admin.users.resetTwoFactorDialog.body")}</p>
          <p className="flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50/70 px-2.5 py-2 text-[11px] leading-4 text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
            <Icon name="warning" size={16} className="mt-px shrink-0" />
            <span>{t("admin.users.resetTwoFactorDialog.warning")}</span>
          </p>
          {error ? <DialogError message={error} /> : null}
        </div>
      </Dialog>

      <Dialog
        open={pending?.kind === "removeUser"}
        onClose={busy ? () => undefined : () => setPending(null)}
        title={t("admin.users.removeDialog.title", { name: pending?.user.name ?? "" })}
        footer={
          <>
            <Button type="button" disabled={busy} onClick={() => setPending(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() =>
                pending?.kind === "removeUser" &&
                run(() => removeUserAction(pending.user.id, pending.user.name))
              }
            >
              {busy ? t("common.working") : t("admin.users.removeDialog.confirm")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-xs leading-5">{t("admin.users.removeDialog.body")}</p>
          {error ? <DialogError message={error} /> : null}
        </div>
      </Dialog>
    </>
  );
}

function DialogError({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs leading-5 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
    >
      {message}
    </p>
  );
}
