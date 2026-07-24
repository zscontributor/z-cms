"use client";

import { useActionState } from "react";
import { updateProfileAction, type ProfileState } from "@/app/actions/user";
import { Field, Input } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { useT } from "@/lib/i18n-provider";

const INITIAL: ProfileState = {};

export function ProfileForm({
  email,
  name,
  avatarUrl,
}: {
  email: string;
  name: string;
  avatarUrl: string | null;
}) {
  const t = useT();
  const [state, formAction] = useActionState(updateProfileAction, INITIAL);

  return (
    <form action={formAction} className="z-card flex flex-col gap-4 p-4">
      {/* Disabled, not absent: the email is what you sign in with, and a form that
          simply omitted it would leave people wondering which account they are on. */}
      <Field label={t("admin.profile.details.email")} htmlFor="profile-email">
        <Input id="profile-email" value={email} disabled readOnly />
      </Field>

      <Field label={t("admin.profile.details.name")} htmlFor="profile-name" required>
        <Input id="profile-name" name="name" defaultValue={name} required maxLength={120} />
      </Field>

      <Field
        label={t("admin.profile.details.avatarUrl")}
        hint={t("admin.profile.details.avatarUrlHint")}
        htmlFor="profile-avatar"
      >
        <Input
          id="profile-avatar"
          name="avatarUrl"
          type="url"
          defaultValue={avatarUrl ?? ""}
          spellCheck={false}
          className="font-mono text-[11px]"
        />
      </Field>

      {state.error ? (
        <p
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs leading-5 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
        >
          {state.error}
        </p>
      ) : null}

      {state.message ? (
        <p
          role="status"
          className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"
        >
          {state.message}
        </p>
      ) : null}

      <SubmitButton variant="primary" className="self-start">
        {t("admin.profile.details.submit")}
      </SubmitButton>
    </form>
  );
}
