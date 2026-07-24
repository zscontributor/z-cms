"use client";

import { useActionState, useState } from "react";
import type { MailSettingsDto } from "@zcmsorg/schemas";
import { saveMailSettingsAction, sendTestMailAction, type MailActionResult } from "@/app/actions/mail";
import { Checkbox, Field, Input } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { useT } from "@/lib/i18n-provider";
import { formatDateTime } from "@/lib/format";

type State = MailActionResult | null;

const save = async (_prev: State, formData: FormData): Promise<State> =>
  saveMailSettingsAction(formData);

const test = async (_prev: State, formData: FormData): Promise<State> =>
  sendTestMailAction(formData);

export function MailSettingsForm({
  settings,
  locale,
  canConfigure,
  canSend,
}: {
  settings: MailSettingsDto;
  locale: string;
  canConfigure: boolean;
  canSend: boolean;
}) {
  const t = useT();
  const [saveState, saveAction] = useActionState(save, null);
  const [testState, testAction] = useActionState(test, null);

  // Clearing the password is an explicit act, not the absence of one. While it is
  // checked the password box is disabled — a form that let you type a new password
  // *and* tick "clear it" would have to decide which one you meant.
  const [clearPassword, setClearPassword] = useState(false);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:items-start">
      <form action={saveAction} className="z-card space-y-6 p-5">
        {settings.fromEnv ? (
          <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 px-4 py-3 text-sm text-blue-800 dark:text-blue-200">
            <p className="font-medium">{t("mail.fromEnv.title")}</p>
            <p className="mt-0.5 text-xs">{t("mail.fromEnv.body")}</p>
          </div>
        ) : null}

        <label className="flex items-start gap-2.5">
          <Checkbox
            name="enabled"
            defaultChecked={settings.enabled}
            disabled={!canConfigure}
            className="mt-0.5"
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium">{t("mail.fields.enabled")}</span>
            <span className="mt-0.5 block text-[11px] leading-4 z-muted">
              {t("mail.fields.enabledHint")}
            </span>
          </span>
        </label>

        <fieldset className="space-y-4 border-t border-[var(--border)] pt-5" disabled={!canConfigure}>
          <legend className="sr-only">{t("mail.server.legend")}</legend>
          <div>
            <h2 className="text-sm font-semibold">{t("mail.server.legend")}</h2>
            <p className="mt-0.5 text-[11px] leading-4 z-muted">{t("mail.server.hint")}</p>
          </div>

          <div className="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <Field label={t("mail.fields.host")} htmlFor="mail-host" required>
              <Input
                id="mail-host"
                name="host"
                defaultValue={settings.host}
                placeholder="smtp.example.com"
                autoComplete="off"
                required
              />
            </Field>
            <Field label={t("mail.fields.port")} htmlFor="mail-port" required>
              <Input
                id="mail-port"
                name="port"
                type="number"
                min={1}
                max={65535}
                defaultValue={settings.port}
                required
              />
            </Field>
          </div>

          <label className="flex items-start gap-2.5">
            <Checkbox name="secure" defaultChecked={settings.secure} className="mt-0.5" />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{t("mail.fields.secure")}</span>
              <span className="mt-0.5 block text-[11px] leading-4 z-muted">
                {t("mail.fields.secureHint")}
              </span>
            </span>
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("mail.fields.username")} htmlFor="mail-username">
              <Input
                id="mail-username"
                name="username"
                defaultValue={settings.username ?? ""}
                autoComplete="off"
              />
            </Field>
            <Field
              label={t("mail.fields.password")}
              htmlFor="mail-password"
              hint={
                settings.hasPassword
                  ? t("mail.fields.passwordSet")
                  : t("mail.fields.passwordUnset")
              }
            >
              {/*
                Never pre-filled, because there is nothing to pre-fill it WITH — the
                API does not return the password, in any form. An empty box means
                "keep what is stored"; the checkbox below is the only way to remove it.
              */}
              <Input
                id="mail-password"
                name="password"
                type="password"
                placeholder={settings.hasPassword ? "••••••••" : ""}
                autoComplete="new-password"
                disabled={clearPassword}
              />
            </Field>
          </div>

          {settings.hasPassword ? (
            <label className="flex items-center gap-2.5">
              <Checkbox
                name="clearPassword"
                checked={clearPassword}
                onChange={(event) => setClearPassword(event.target.checked)}
              />
              <span className="text-sm">{t("mail.fields.passwordClear")}</span>
            </label>
          ) : null}
        </fieldset>

        <fieldset className="space-y-4 border-t border-[var(--border)] pt-5" disabled={!canConfigure}>
          <legend className="sr-only">{t("mail.sender.legend")}</legend>
          <div>
            <h2 className="text-sm font-semibold">{t("mail.sender.legend")}</h2>
            <p className="mt-0.5 text-[11px] leading-4 z-muted">{t("mail.sender.hint")}</p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("mail.fields.fromName")} htmlFor="mail-from-name" required>
              <Input
                id="mail-from-name"
                name="fromName"
                defaultValue={settings.fromName}
                placeholder="Z-CMS"
                required
              />
            </Field>
            <Field label={t("mail.fields.fromEmail")} htmlFor="mail-from-email" required>
              <Input
                id="mail-from-email"
                name="fromEmail"
                type="email"
                defaultValue={settings.fromEmail}
                placeholder="no-reply@example.com"
                required
              />
            </Field>
          </div>

          <Field
            label={t("mail.fields.replyTo")}
            htmlFor="mail-reply-to"
            hint={t("mail.fields.replyToHint")}
          >
            <Input
              id="mail-reply-to"
              name="replyTo"
              type="email"
              defaultValue={settings.replyTo ?? ""}
            />
          </Field>
        </fieldset>

        <div className="flex items-center gap-3 border-t border-[var(--border)] pt-5">
          <SubmitButton variant="primary" disabled={!canConfigure}>
            {t("mail.actions.save")}
          </SubmitButton>
          <Result state={saveState} />
        </div>
      </form>

      <div className="z-card space-y-4 p-5">
        <div>
          <h2 className="text-sm font-semibold">{t("mail.actions.sendTest")}</h2>
          <p className="mt-0.5 text-[11px] leading-4 z-muted">{t("mail.actions.saveFirst")}</p>
        </div>

        <TestStatus settings={settings} locale={locale} />

        <form action={testAction} className="space-y-3">
          <Field label={t("mail.actions.testTo")} htmlFor="mail-test-to">
            <Input
              id="mail-test-to"
              name="to"
              type="email"
              placeholder="you@example.com"
              required
              disabled={!canSend}
            />
          </Field>
          <SubmitButton
            disabled={!canSend}
            pendingLabel={t("mail.actions.sending")}
            className="w-full"
          >
            {t("mail.actions.sendTest")}
          </SubmitButton>
          <Result state={testState} />
        </form>
      </div>
    </div>
  );
}

/**
 * What the mail server said last time anyone asked it. The only evidence on this
 * screen that the configuration is real rather than merely plausible.
 */
function TestStatus({ settings, locale }: { settings: MailSettingsDto; locale: string }) {
  const t = useT();

  if (!settings.lastTestAt) {
    return <p className="text-xs z-muted">{t("mail.status.never")}</p>;
  }

  const when = formatDateTime(settings.lastTestAt, locale);

  if (settings.lastTestError) {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5">
        <p className="text-xs font-medium text-red-700 dark:text-red-300">
          {t("mail.status.failed", { when })}
        </p>
        {/* The SMTP server's own words, verbatim. "535 authentication failed" is
            the sentence that solves this; a friendlier paraphrase is not. */}
        <p className="mt-1 break-words font-mono text-[11px] leading-4 text-red-700/80 dark:text-red-300/80">
          {settings.lastTestError}
        </p>
      </div>
    );
  }

  return (
    <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
      {t("mail.status.ok", { when })}
    </p>
  );
}

function Result({ state }: { state: State }) {
  if (!state) return null;
  return (
    <span
      role="status"
      className={
        state.ok
          ? "text-xs text-emerald-600 dark:text-emerald-400"
          : "text-xs text-red-600 dark:text-red-400"
      }
    >
      {state.ok ? state.message : state.error}
    </span>
  );
}
