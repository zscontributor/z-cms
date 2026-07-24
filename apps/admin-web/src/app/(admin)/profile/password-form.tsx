"use client";

import { useActionState } from "react";
import { PASSWORD_MIN } from "@zcmsorg/schemas";
import { changePasswordAction, type ProfileState } from "@/app/actions/user";
import { Field, Input } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { Icon } from "@/components/shell/icon";
import { useT } from "@/lib/i18n-provider";

const INITIAL: ProfileState = {};

/**
 * There is no success message, and there cannot be: a successful change ends
 * every session — this one included — and the action redirects to /login. The
 * warning above the button is what stands in for it, because being signed out
 * without having been told is indistinguishable from something breaking.
 */
export function PasswordForm() {
  const t = useT();
  const [state, formAction] = useActionState(changePasswordAction, INITIAL);

  return (
    <form action={formAction} className="z-card flex flex-col gap-4 p-4">
      <Field label={t("admin.profile.password.current")} htmlFor="current-password" required>
        <Input
          id="current-password"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
        />
      </Field>

      <Field
        label={t("admin.profile.password.new")}
        hint={t("admin.profile.password.newHint", { min: PASSWORD_MIN })}
        htmlFor="new-password"
        required
      >
        <Input
          id="new-password"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          minLength={PASSWORD_MIN}
          required
        />
      </Field>

      <Field label={t("admin.profile.password.confirm")} htmlFor="confirm-password" required>
        <Input
          id="confirm-password"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          minLength={PASSWORD_MIN}
          required
        />
      </Field>

      <p className="flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50/70 px-2.5 py-2 text-[11px] leading-4 text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
        <Icon name="warning" size={16} className="mt-px shrink-0" />
        <span>{t("admin.profile.password.description")}</span>
      </p>

      {state.error ? (
        <p
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs leading-5 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
        >
          {state.error}
        </p>
      ) : null}

      <SubmitButton
        variant="primary"
        className="self-start"
        pendingLabel={t("admin.profile.password.submitting")}
      >
        {t("admin.profile.password.submit")}
      </SubmitButton>
    </form>
  );
}
