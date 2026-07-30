"use client";

import { useActionState, useState } from "react";
import { ROLES, type SiteDto } from "@zcmsorg/schemas";
import {
  createUserAction,
  type CreateUserState,
  type CreateUserValues,
} from "@/app/actions/user";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { Field, Input, Select } from "@/components/ui/field";
import { Icon } from "@/components/shell/icon";
import { useT } from "@/lib/i18n-provider";

const INITIAL: CreateUserState = {};
const FORM_ID = "invite-user-form";

/**
 * The header trigger: a "+" button that opens the create-user drawer. Keeping the
 * form off the list screen until it is wanted mirrors the Sites and Menus screens.
 */
export function InviteForm({ sites }: { sites: SiteDto[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(
    createUserAction,
    INITIAL,
  );

  const created = state.created;

  // A successful create leaves a new row the table has not loaded yet, so closing
  // the drawer after one refreshes the page rather than just dismissing it.
  const close = () => {
    if (created) window.location.reload();
    else setOpen(false);
  };

  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        <Icon name="plus" className="h-4 w-4" />
        {t("admin.users.invite.heading")}
      </Button>

      <Drawer
        open={open}
        onClose={() => (pending ? undefined : close())}
        title={t("admin.users.invite.heading")}
        description={t("admin.users.invite.description")}
        footer={
          created ? undefined : (
            <>
              <Button
                variant="secondary"
                onClick={() => setOpen(false)}
                disabled={pending}
              >
                {t("common.cancel")}
              </Button>
              <Button
                type="submit"
                form={FORM_ID}
                variant="primary"
                disabled={pending}
              >
                {pending
                  ? t("admin.users.invite.submitting")
                  : t("admin.users.invite.submit")}
              </Button>
            </>
          )
        }
      >
        {created ? (
          <CreatedAccount created={created} />
        ) : (
          <InviteFields
            sites={sites}
            action={formAction}
            error={state.error}
            values={state.values}
          />
        )}
      </Drawer>
    </>
  );
}

/**
 * Creates a usable account immediately.
 *
 * Email is a notification path, not an activation gate: the user row and
 * membership exist before the message leaves the queue. The temporary password is
 * shown once as a fallback for the ordinary reason mail fails: SMTP settings are
 * not always ready on day one.
 *
 * Every field is defaulted from `values` — what the last attempt was submitted
 * with — rather than left blank. React resets an uncontrolled form when its
 * action resolves, and it resets fields to the defaults rendered at that moment;
 * echoing them back is what turns "your address is already taken" from a blank
 * drawer into a one-word correction.
 */
function InviteFields({
  sites,
  action,
  error,
  values,
}: {
  sites: SiteDto[];
  action: (formData: FormData) => void;
  error?: string;
  values?: CreateUserValues;
}) {
  const t = useT();
  return (
    <form id={FORM_ID} action={action} className="flex flex-col gap-4">
      <Field
        label={t("admin.users.invite.name")}
        htmlFor="invite-name"
        required
      >
        <Input
          id="invite-name"
          name="name"
          type="text"
          required
          autoComplete="off"
          defaultValue={values?.name ?? ""}
          placeholder={t("admin.users.invite.namePlaceholder")}
        />
      </Field>

      <Field
        label={t("admin.users.invite.email")}
        htmlFor="invite-email"
        required
      >
        <Input
          id="invite-email"
          name="email"
          type="email"
          required
          autoComplete="off"
          spellCheck={false}
          defaultValue={values?.email ?? ""}
          placeholder={t("admin.users.invite.emailPlaceholder")}
        />
      </Field>

      <Field
        label={t("admin.users.invite.password")}
        hint={t("admin.users.invite.passwordHint")}
        htmlFor="invite-password"
      >
        <Input
          id="invite-password"
          name="password"
          type="text"
          autoComplete="off"
          spellCheck={false}
          defaultValue={values?.password ?? ""}
          placeholder={t("admin.users.invite.passwordPlaceholder")}
        />
      </Field>

      <Field
        label={t("admin.users.invite.scope")}
        hint={t("admin.users.role.scopeHint")}
        htmlFor="invite-scope"
      >
        <Select id="invite-scope" name="siteId" defaultValue={values?.siteId ?? ""}>
          <option value="">{t("admin.users.tenantWide")}</option>
          {sites.map((site) => (
            <option key={site.id} value={site.id}>
              {site.name}
            </option>
          ))}
        </Select>
      </Field>

      <Field label={t("admin.users.invite.role")} htmlFor="invite-role">
        <Select id="invite-role" name="role" defaultValue={values?.role ?? "VIEWER"}>
          {ROLES.map((role) => (
            <option key={role} value={role}>
              {t(`admin.roles.${role}`)}
            </option>
          ))}
        </Select>
      </Field>

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs leading-5 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
        >
          {error}
        </p>
      ) : null}
    </form>
  );
}

/** The one-time view of the generated login details. */
function CreatedAccount({
  created,
}: {
  created: NonNullable<CreateUserState["created"]>;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  const details = `${created.loginUrl}\n${created.user.email}\n${created.password}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(details);
      setCopied(true);
    } catch {
      // Clipboard access can be refused (an insecure origin, a locked-down
      // browser). The link is on screen and selectable either way, which is why
      // this is not an error worth interrupting anyone with.
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <Icon name="key" size={16} />
          {t("admin.users.invite.createdHeading")}
        </h3>
        <p className="mt-0.5 text-[11px] z-muted">{created.user.email}</p>
      </div>

      <p className="flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50/70 px-2.5 py-2 text-[11px] leading-4 text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
        <Icon name="warning" size={16} className="mt-px shrink-0" />
        <span>
          {created.emailQueued
            ? t("admin.users.invite.createdBodyQueued")
            : t("admin.users.invite.createdBodyManual")}
        </span>
      </p>

      <code className="block max-h-24 overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--surface-sunken)] p-2 font-mono text-[11px] break-all">
        {t("admin.users.invite.login")}: {created.loginUrl}
        {"\n"}
        {t("admin.users.invite.email")}: {created.user.email}
        {"\n"}
        {t("admin.users.invite.password")}: {created.password}
      </code>

      <div className="flex gap-2">
        <Button variant="primary" size="sm" onClick={copy}>
          <Icon name={copied ? "check" : "copy"} size={15} />
          {copied
            ? t("admin.users.invite.copied")
            : t("admin.users.invite.copyDetails")}
        </Button>
        {/* A reload drops the temporary password from memory; the account itself
            already exists and can sign in. */}
        <Button size="sm" onClick={() => window.location.reload()}>
          {t("admin.users.invite.done")}
        </Button>
      </div>
    </div>
  );
}
