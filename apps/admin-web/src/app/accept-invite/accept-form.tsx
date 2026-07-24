"use client";

import { useActionState } from "react";
import { PASSWORD_MIN } from "@zcmsorg/schemas";
import { acceptInviteAction, type AcceptInviteState } from "@/app/actions/auth";
import { Field, Input } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { useT } from "@/lib/i18n-provider";

const INITIAL: AcceptInviteState = {};

/**
 * The email is not asked for, and not shown: it is carried by the invitation, and
 * a field for it would only invite someone to type a different one — which the
 * API would ignore, because the account is created from the stored row, never
 * from this body.
 */
export function AcceptInviteForm({ token }: { token: string }) {
  const t = useT();
  const [state, formAction] = useActionState(acceptInviteAction, INITIAL);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="token" value={token} />

      <Field label={t("auth.acceptInvite.name")} htmlFor="invite-name" required>
        <Input
          id="invite-name"
          name="name"
          required
          autoFocus
          autoComplete="name"
          maxLength={120}
          placeholder={t("auth.acceptInvite.namePlaceholder")}
        />
        <FieldError message={state.fieldErrors?.name} />
      </Field>

      <Field
        label={t("auth.acceptInvite.password")}
        hint={t("auth.acceptInvite.passwordHint", { min: PASSWORD_MIN })}
        htmlFor="invite-password"
        required
      >
        <Input
          id="invite-password"
          name="password"
          type="password"
          required
          autoComplete="new-password"
          minLength={PASSWORD_MIN}
        />
        <FieldError message={state.fieldErrors?.password} />
      </Field>

      <Field label={t("auth.acceptInvite.confirmPassword")} htmlFor="invite-confirm" required>
        <Input
          id="invite-confirm"
          name="confirmPassword"
          type="password"
          required
          autoComplete="new-password"
          minLength={PASSWORD_MIN}
        />
        <FieldError message={state.fieldErrors?.confirmPassword} />
      </Field>

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
        className="w-full"
        pendingLabel={t("auth.acceptInvite.submitting")}
      >
        {t("auth.acceptInvite.submit")}
      </SubmitButton>
    </form>
  );
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">{message}</p>;
}
