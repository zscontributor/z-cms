"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { loginAction, verifyMfaAction, type LoginState } from "@/app/actions/auth";
import { Field, Input } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { Icon } from "@/components/shell/icon";
import { useT } from "@/lib/i18n-provider";

const INITIAL: LoginState = {};

/**
 * Login, in one step or two.
 *
 * The second step is a *different form* bound to a *different action*, not the
 * same one with an extra field. That is what keeps the password out of the second
 * submission: once the challenge exists, the browser has no reason to still be
 * holding the password, and it does not.
 */
export function LoginForm({ next }: { next: string }) {
  const [state, formAction] = useActionState(loginAction, INITIAL);

  if (state.challengeToken) {
    return <MfaStep challengeToken={state.challengeToken} next={next} />;
  }

  return <PasswordStep state={state} formAction={formAction} next={next} />;
}

function PasswordStep({
  state,
  formAction,
  next,
}: {
  state: LoginState;
  formAction: (payload: FormData) => void;
  next: string;
}) {
  const t = useT();

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="next" value={next} />

      <Field label={t("auth.login.email")} htmlFor="email" required>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          placeholder={t("auth.login.emailPlaceholder")}
          required
          autoFocus
        />
        {state.fieldErrors?.email ? (
          <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">
            {state.fieldErrors.email}
          </p>
        ) : null}
      </Field>

      <Field label={t("auth.login.password")} htmlFor="password" required>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          placeholder="••••••••"
          required
        />
        {state.fieldErrors?.password ? (
          <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">
            {state.fieldErrors.password}
          </p>
        ) : null}
      </Field>

      {state.error ? (
        <p
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
        >
          {state.error}
        </p>
      ) : null}

      <SubmitButton
        variant="primary"
        className="mt-1 w-full"
        pendingLabel={t("auth.login.submitting")}
      >
        {t("auth.login.submit")}
      </SubmitButton>
    </form>
  );
}

/**
 * The code step.
 *
 * `autoComplete="one-time-code"` and `inputMode="numeric"` are not decoration —
 * they are what makes a phone offer the code and show a number pad. But the field
 * stays a TEXT input, never a number one: a recovery code goes in the same box,
 * and a leading zero has to survive being typed.
 */
function MfaStep({ challengeToken, next }: { challengeToken: string; next: string }) {
  const t = useT();
  const [state, formAction] = useActionState(verifyMfaAction, INITIAL);
  const [seconds, setSeconds] = useState(300);
  const inputRef = useRef<HTMLInputElement>(null);

  // A wrong code re-renders this form with the same challenge. Put the cursor back
  // where the person is already looking.
  useEffect(() => {
    if (state.fieldErrors?.code) inputRef.current?.select();
  }, [state.fieldErrors?.code]);

  // The ticket really does expire. A form that lets someone type carefully for six
  // minutes and only then says "start again" wasted their time on purpose.
  useEffect(() => {
    const timer = setInterval(() => setSeconds((value) => Math.max(0, value - 1)), 1000);
    return () => clearInterval(timer);
  }, []);

  const expired = seconds === 0;

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {/* The ticket from step one. The password is deliberately not here. */}
      <input type="hidden" name="challengeToken" value={challengeToken} />
      <input type="hidden" name="next" value={next} />

      <div className="flex items-start gap-2 rounded-md border border-[var(--border)] bg-[var(--surface-sunken)] px-3 py-2.5">
        <Icon name="shield" size={18} className="mt-px shrink-0 text-brand-500" />
        <p className="text-xs leading-5 z-muted">{t("auth.mfa.prompt")}</p>
      </div>

      <Field label={t("auth.mfa.code")} hint={t("auth.mfa.codeHint")} htmlFor="mfa-code" required>
        <Input
          ref={inputRef}
          id="mfa-code"
          name="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          required
          spellCheck={false}
          disabled={expired}
          placeholder="123456"
          className="text-center font-mono text-lg tracking-[0.3em]"
        />
        {state.fieldErrors?.code ? (
          <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">
            {state.fieldErrors.code}
          </p>
        ) : null}
      </Field>

      {state.error ? (
        <p
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs leading-5 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
        >
          {state.error}
        </p>
      ) : null}

      {expired ? (
        <p
          role="alert"
          className="rounded-md border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs leading-5 text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300"
        >
          {t("auth.mfa.challengeExpired")}
        </p>
      ) : null}

      <SubmitButton
        variant="primary"
        className="w-full"
        disabled={expired}
        pendingLabel={t("auth.mfa.submitting")}
      >
        {t("auth.mfa.submit")}
      </SubmitButton>

      {!expired ? (
        <p className="text-center text-[11px] z-muted">
          {t("auth.mfa.expiresIn", { seconds })}
        </p>
      ) : null}

      {/* A full reload is the honest "start over": it drops the ticket, and the
          password was never in this form to begin with. */}
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="text-center text-[11px] underline underline-offset-2 z-muted hover:text-[var(--text)]"
      >
        {t("auth.mfa.startOver")}
      </button>
    </form>
  );
}
