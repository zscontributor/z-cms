"use client";

import { useState, useTransition } from "react";
import {
  disableTotpAction,
  enableTotpAction,
  regenerateRecoveryCodesAction,
  setupTotpAction,
  type TotpSetupResult,
} from "@/app/actions/user";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/field";
import { Icon } from "@/components/shell/icon";
import { useT } from "@/lib/i18n-provider";

/**
 * The 2FA panel: off, enrolling, or on.
 *
 * The enrollment is deliberately two steps on screen as well as on the wire. A
 * QR that switched 2FA on the moment it was drawn would lock out anyone who
 * closed the tab before scanning it — with a protection they cannot pass and
 * cannot remove.
 */
export function TwoFactorPanel({ enabled }: { enabled: boolean }) {
  const t = useT();

  const [setup, setSetup] = useState<Extract<TotpSetupResult, { ok: true }> | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [disabling, setDisabling] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  function reset() {
    setCode("");
    setPassword("");
    setError(null);
  }

  function begin() {
    reset();
    setNotice(null);
    startTransition(async () => {
      const result = await setupTotpAction();
      if (!result.ok) return setError(result.error);
      setSetup(result);
    });
  }

  function confirm() {
    setError(null);
    startTransition(async () => {
      const result = await enableTotpAction(code);
      if (!result.ok) return setError(result.error);
      setSetup(null);
      reset();
      // The codes replace the panel entirely — see RecoveryCodes. They exist in
      // readable form exactly once, and nothing else on this screen matters until
      // the person has written them down.
      setCodes(result.codes);
    });
  }

  function confirmDisable() {
    setError(null);
    startTransition(async () => {
      const result = await disableTotpAction(password, code);
      if (!result.ok) return setError(result.error);
      setDisabling(false);
      reset();
      setNotice(result.message);
    });
  }

  function confirmRegenerate() {
    setError(null);
    startTransition(async () => {
      const result = await regenerateRecoveryCodesAction(password);
      if (!result.ok) return setError(result.error);
      setRegenerating(false);
      reset();
      setCodes(result.codes);
    });
  }

  if (codes) {
    return <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />;
  }

  return (
    <>
      <div className="z-card flex flex-col gap-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <Icon name="shield" size={16} />
            {t("admin.profile.twoFactor.heading")}
          </h3>
          <Badge tone={enabled ? "success" : "warning"}>
            {enabled ? t("admin.profile.twoFactor.on") : t("admin.profile.twoFactor.off")}
          </Badge>
        </div>

        <p className="text-xs leading-5 z-muted">
          {enabled
            ? t("admin.profile.twoFactor.enabledBody")
            : t("admin.profile.twoFactor.disabledBody")}
        </p>

        {notice ? (
          <p
            role="status"
            className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"
          >
            {notice}
          </p>
        ) : null}

        {error && !setup && !disabling && !regenerating ? <Alert message={error} /> : null}

        <div className="flex flex-wrap gap-2">
          {enabled ? (
            <>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => {
                  reset();
                  setRegenerating(true);
                }}
              >
                <Icon name="retry" size={15} />
                {t("admin.profile.twoFactor.regenerate")}
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={busy}
                onClick={() => {
                  reset();
                  setDisabling(true);
                }}
              >
                {t("admin.profile.twoFactor.disable")}
              </Button>
            </>
          ) : (
            <Button variant="primary" size="sm" disabled={busy} onClick={begin}>
              <Icon name="shield" size={15} />
              {busy ? t("common.working") : t("admin.profile.twoFactor.enable")}
            </Button>
          )}
        </div>
      </div>

      {/* Enrollment */}
      <Dialog
        open={setup !== null}
        onClose={busy ? () => undefined : () => setSetup(null)}
        title={t("admin.profile.twoFactor.setup.title")}
        footer={
          <>
            <Button type="button" disabled={busy} onClick={() => setSetup(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={busy || code.trim().length !== 6}
              onClick={confirm}
            >
              {busy ? t("common.working") : t("admin.profile.twoFactor.setup.confirm")}
            </Button>
          </>
        }
      >
        {setup ? (
          <div className="flex flex-col gap-4">
            <p className="text-xs leading-5">{t("admin.profile.twoFactor.setup.body")}</p>

            {/* The QR is rendered on the server as an SVG. No third party ever sees
                the secret, and the CSP never has to allow a remote image. */}
            <div
              className="mx-auto w-44 rounded-md bg-white p-2"
              aria-label={t("admin.profile.twoFactor.setup.qrAlt")}
              dangerouslySetInnerHTML={{ __html: setup.qrSvg }}
            />

            <div>
              <p className="mb-1 text-[11px] z-muted">
                {t("admin.profile.twoFactor.setup.manual")}
              </p>
              <code className="block rounded-md border border-[var(--border)] bg-[var(--surface-sunken)] p-2 text-center font-mono text-xs break-all">
                {setup.setup.secret}
              </code>
            </div>

            <Field
              label={t("admin.profile.twoFactor.setup.code")}
              hint={t("admin.profile.twoFactor.setup.codeHint")}
              htmlFor="totp-enable-code"
              required
            >
              <Input
                id="totp-enable-code"
                value={code}
                disabled={busy}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                spellCheck={false}
                placeholder="123456"
                className="text-center font-mono text-lg tracking-[0.3em]"
                onChange={(event) => setCode(event.target.value)}
              />
            </Field>

            {error ? <Alert message={error} /> : null}
          </div>
        ) : null}
      </Dialog>

      {/* Disable */}
      <Dialog
        open={disabling}
        onClose={busy ? () => undefined : () => setDisabling(false)}
        title={t("admin.profile.twoFactor.disableDialog.title")}
        footer={
          <>
            <Button type="button" disabled={busy} onClick={() => setDisabling(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy || !password || !code.trim()}
              onClick={confirmDisable}
            >
              {busy ? t("common.working") : t("admin.profile.twoFactor.disable")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-xs leading-5">{t("admin.profile.twoFactor.disableDialog.body")}</p>

          <Field
            label={t("admin.profile.password.current")}
            htmlFor="totp-disable-password"
            required
          >
            <Input
              id="totp-disable-password"
              type="password"
              value={password}
              disabled={busy}
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>

          <Field
            label={t("auth.mfa.code")}
            hint={t("auth.mfa.codeHint")}
            htmlFor="totp-disable-code"
            required
          >
            <Input
              id="totp-disable-code"
              value={code}
              disabled={busy}
              inputMode="numeric"
              autoComplete="one-time-code"
              spellCheck={false}
              className="text-center font-mono tracking-[0.2em]"
              onChange={(event) => setCode(event.target.value)}
            />
          </Field>

          {error ? <Alert message={error} /> : null}
        </div>
      </Dialog>

      {/* Regenerate recovery codes */}
      <Dialog
        open={regenerating}
        onClose={busy ? () => undefined : () => setRegenerating(false)}
        title={t("admin.profile.twoFactor.regenerateDialog.title")}
        footer={
          <>
            <Button type="button" disabled={busy} onClick={() => setRegenerating(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={busy || !password}
              onClick={confirmRegenerate}
            >
              {busy ? t("common.working") : t("admin.profile.twoFactor.regenerate")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-xs leading-5">
            {t("admin.profile.twoFactor.regenerateDialog.body")}
          </p>

          <Field
            label={t("admin.profile.password.current")}
            htmlFor="totp-regen-password"
            required
          >
            <Input
              id="totp-regen-password"
              type="password"
              value={password}
              disabled={busy}
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>

          {error ? <Alert message={error} /> : null}
        </div>
      </Dialog>
    </>
  );
}

/**
 * The recovery codes, shown once.
 *
 * It takes over the panel rather than sitting in a dialog someone can dismiss
 * with Escape by reflex. Only the hashes are stored, so there is no endpoint that
 * could ever show these again — the only honest options are "write them down now"
 * or "generate a new set", and the screen says exactly that.
 */
function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopied(true);
    } catch {
      // Clipboard access can be refused. The codes are on screen and selectable,
      // which is why this is not worth interrupting anyone with.
    }
  }

  return (
    <div className="z-card flex flex-col gap-3 p-4">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold">
        <Icon name="key" size={16} />
        {t("admin.profile.twoFactor.codes.heading")}
      </h3>

      <p className="flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50/70 px-2.5 py-2 text-[11px] leading-4 text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
        <Icon name="warning" size={16} className="mt-px shrink-0" />
        <span>{t("admin.profile.twoFactor.codes.body")}</span>
      </p>

      <ul className="grid grid-cols-2 gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface-sunken)] p-3">
        {codes.map((value) => (
          <li key={value} className="text-center font-mono text-xs tracking-wide">
            {value}
          </li>
        ))}
      </ul>

      <div className="flex gap-2">
        <Button size="sm" onClick={copy}>
          <Icon name={copied ? "check" : "copy"} size={15} />
          {copied ? t("admin.users.invite.copied") : t("admin.profile.twoFactor.codes.copy")}
        </Button>
        <Button variant="primary" size="sm" onClick={onDone}>
          {t("admin.profile.twoFactor.codes.done")}
        </Button>
      </div>
    </div>
  );
}

function Alert({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs leading-5 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
    >
      {message}
    </p>
  );
}
