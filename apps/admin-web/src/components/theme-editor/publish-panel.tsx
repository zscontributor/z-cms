"use client";

import { useEffect, useState, useTransition, type ReactNode } from "react";
import {
  assessPassphrase,
  createPublisherKey,
  importPublisherKey,
  signChecksumWithVault,
  supportsEd25519,
  PublisherKeyError,
  type WrappedKey,
} from "@/lib/publisher-key";
import {
  connectMarketplaceTokenAction,
  disconnectMarketplaceTokenAction,
  forgetPublisherKeyAction,
  getPublisherKeyAction,
  savePublisherKeyAction,
  sealThemeDraftAction,
  submitThemeDraftAction,
  type WrappedKeyDto,
} from "@/app/actions/publisher-key";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/field";
import { Icon } from "@/components/shell/icon";
import { useLocale, useT } from "@/lib/i18n-provider";

/**
 * Publishing, without a terminal.
 *
 * This panel is what replaces `zcms keygen` + `zcms pack`. It keeps the promise
 * those commands make — the private key never leaves the author's machine — by
 * doing the signing here, in the page: the platform signs a 64-byte checksum, and a
 * browser can do that.
 *
 * The passphrase lives in this component's state for the length of one click and is
 * never sent anywhere. What the server holds is ciphertext it cannot open.
 */
export function PublishPanel({
  draftId,
  draftKey,
  payloadChecksum,
  canPublish,
}: {
  draftId: string;
  draftKey: string;
  /** `theme:publish` — putting the company's name on a public package. */
  canPublish: boolean;
  /**
   * The digest to sign, set by the last build. Null means there is nothing staged
   * — the author has to build before Sign means anything.
   *
   * It is handed down rather than fetched: it comes from the draft the page already
   * loaded, and this component has never seen the bytes it describes.
   */
  payloadChecksum: string | null;
}) {
  const t = useT();
  const locale = useLocale();
  const [helpOpen, setHelpOpen] = useState(false);
  const [vault, setVault] = useState<WrappedKeyDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    void (async () => {
      setSupported(await supportsEd25519());
      const result = await getPublisherKeyAction();
      if (result.ok) setVault(result.data);
      else setError(result.error);
      setLoading(false);
    })();
  }, []);

  /** Wraps whatever `make` produces and stores the blob. */
  function saveKey(make: () => Promise<WrappedKey>) {
    setError(null);
    start(async () => {
      try {
        const wrapped = await make();
        const saved = await savePublisherKeyAction(wrapped);
        if (!saved.ok) return setError(saved.error);
        setVault(saved.data);
        setPassphrase("");
        setMessage(t("themeEditor.publish.keySaved"));
      } catch (err) {
        setError(err instanceof PublisherKeyError ? err.message : String(err));
      }
    });
  }

  /**
   * Sign here, then do one of two things with it.
   *
   * Unwrapping and signing happen in this page; the server only assembles. It
   * re-verifies the signature before wrapping, so a wrong passphrase (caught by the
   * GCM tag in signChecksumWithVault) and a wrong key (caught there) both stop
   * before anything reaches the marketplace.
   */
  function withSignature(then: (signature: string) => Promise<void>) {
    if (!vault || !payloadChecksum) return;
    setError(null);
    start(async () => {
      try {
        await then(await signChecksumWithVault(vault, passphrase, payloadChecksum));
        setPassphrase("");
      } catch (err) {
        setError(err instanceof PublisherKeyError ? err.message : String(err));
      }
    });
  }

  function signAndDownload() {
    withSignature(async (signature) => {
      const sealed = await sealThemeDraftAction(draftId, signature, vault!.publicKeyPem);
      if (!sealed.ok) return setError(sealed.error);
      download(sealed.data.filename, sealed.data.base64);
      setMessage(t("themeEditor.publish.signed"));
    });
  }

  function signAndSubmit() {
    withSignature(async (signature) => {
      const res = await submitThemeDraftAction(draftId, signature, vault!.publicKeyPem);
      if (!res.ok) return setError(res.error);
      setMessage(t("themeEditor.publish.submitted", { status: res.data.reviewStatus }));
    });
  }

  if (loading) return <p className="p-4 text-xs z-muted">…</p>;

  if (supported === false) {
    // Named plainly rather than left as a broken button. Ed25519 in WebCrypto is
    // recent; an author on an old browser needs to know it is the browser.
    return (
      <p className="m-4 rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-950/40">
        {t("themeEditor.publish.unsupported")}
      </p>
    );
  }

  return (
    <>
    <section className="space-y-3 border-t border-neutral-200 p-4 dark:border-neutral-800">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          {t("themeEditor.publish.heading")}
        </h3>
        {/* How does publishing work? Two ways to submit, and what Public key and the
            API token are — explained in a modal so the panel stays lean. */}
        <button
          type="button"
          onClick={() => setHelpOpen(true)}
          aria-label={t("themeEditor.publish.help.open")}
          title={t("themeEditor.publish.help.open")}
          className="shrink-0 rounded p-0.5 text-neutral-400 transition-colors hover:text-neutral-700 dark:hover:text-neutral-200"
        >
          <Icon name="info" className="h-4 w-4" />
        </button>
      </div>

      {error ? <p className="text-xs text-red-600">{error}</p> : null}
      {message ? <p className="text-xs text-green-600">{message}</p> : null}

      {!vault ? (
        <NewKeyForm passphrase={passphrase} setPassphrase={setPassphrase} pending={pending} onCreate={() => saveKey(() => createPublisherKey(passphrase))} onImport={(pem) => saveKey(() => importPublisherKey(pem, passphrase))} />
      ) : (
        <>
          <Field label={t("themeEditor.publish.publicKey")} hint={t("themeEditor.publish.publicKeyHint")}>
            <Textarea readOnly rows={4} value={vault.publicKeyPem} className="font-mono text-[10px]" />
          </Field>

          {!payloadChecksum ? (
            // Any edit clears the staged build, so this is also what an author sees
            // after changing the design: build again, then sign what was built.
            <p className="text-xs z-muted">{t("themeEditor.publish.buildFirst")}</p>
          ) : (
            <>
              <Field label={t("themeEditor.publish.passphrase")}>
                <Input
                  type="password"
                  autoComplete="off"
                  value={passphrase}
                  disabled={pending}
                  onChange={(e) => setPassphrase(e.target.value)}
                />
              </Field>
              <div className="flex flex-wrap gap-2">
                {/* Submit is the consequential one, so it is the primary button —
                    but only when it can actually work. Offering it without a token
                    would be a button whose whole job is to produce an error. */}
                {canPublish && vault.hasMarketplaceToken ? (
                  <Button size="sm" disabled={pending || !passphrase} onClick={signAndSubmit}>
                    {pending ? t("themeEditor.actions.saving") : t("themeEditor.publish.submit")}
                  </Button>
                ) : null}
                <Button
                  variant={canPublish && vault.hasMarketplaceToken ? "ghost" : "primary"}
                  size="sm"
                  disabled={pending || !passphrase}
                  onClick={signAndDownload}
                >
                  {t("themeEditor.publish.sign")}
                </Button>
              </div>
            </>
          )}

          {canPublish ? (
            <MarketplaceToken
              connected={vault.hasMarketplaceToken}
              pending={pending}
              onConnect={(token) =>
                start(async () => {
                  const r = await connectMarketplaceTokenAction(token);
                  if (!r.ok) return setError(r.error);
                  setVault({ ...vault, hasMarketplaceToken: true });
                  setMessage(t("themeEditor.publish.tokenConnected"));
                })
              }
              onDisconnect={() =>
                start(async () => {
                  const r = await disconnectMarketplaceTokenAction();
                  if (!r.ok) return setError(r.error);
                  setVault({ ...vault, hasMarketplaceToken: false });
                })
              }
            />
          ) : null}

          <details className="text-xs">
            <summary className="cursor-pointer z-muted">{t("themeEditor.publish.manage")}</summary>
            <p className="mt-2 z-muted">{t("themeEditor.publish.forgetHint")}</p>
            <Button
              variant="danger"
              size="sm"
              className="mt-2"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await forgetPublisherKeyAction();
                  if (r.ok) setVault(null);
                  else setError(r.error);
                })
              }
            >
              {t("themeEditor.publish.forget")}
            </Button>
          </details>
        </>
      )}

      <p className="text-[11px] z-muted">{t("themeEditor.publish.submitHint", { key: draftKey })}</p>
    </section>

    <Dialog
      open={helpOpen}
      onClose={() => setHelpOpen(false)}
      title={t("themeEditor.publish.help.title")}
      description={t("themeEditor.publish.help.intro")}
      footer={
        <Button type="button" variant="primary" onClick={() => setHelpOpen(false)}>
          {t("common.close")}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <section className="rounded-md border border-[var(--border)] bg-[var(--surface-sunken)] p-3">
          <h3 className="text-xs font-semibold">{t("themeEditor.publish.help.way1Title")}</h3>
          <p className="mt-0.5 text-[11px] leading-4 z-muted">
            {t("themeEditor.publish.help.way1Body")}
          </p>
          <DocLink locale={locale} path="marketplace/publishing">
            {t("themeEditor.publish.help.way1Link")}
          </DocLink>
        </section>

        <section className="rounded-md border border-[var(--border)] bg-[var(--surface-sunken)] p-3">
          <h3 className="text-xs font-semibold">{t("themeEditor.publish.help.way2Title")}</h3>
          <p className="mt-0.5 text-[11px] leading-4 z-muted">
            {t("themeEditor.publish.help.way2Body")}
          </p>
          <dl className="mt-2.5 flex flex-col gap-2.5">
            <div>
              <dt className="text-xs font-medium">{t("themeEditor.publish.help.publicKeyTitle")}</dt>
              <dd className="mt-0.5 text-[11px] leading-4 z-muted">
                {t("themeEditor.publish.help.publicKeyBody")}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium">{t("themeEditor.publish.help.tokenTitle")}</dt>
              <dd className="mt-0.5 text-[11px] leading-4 z-muted">
                {t("themeEditor.publish.help.tokenBody")}
              </dd>
              <DocLink locale={locale} path="marketplace/api-tokens">
                {t("themeEditor.publish.help.tokenLink")}
              </DocLink>
            </div>
          </dl>
          <p className="mt-2.5 text-[11px] leading-4 z-muted">
            {t("themeEditor.publish.help.way2Outro")}
          </p>
        </section>
      </div>
    </Dialog>
    </>
  );
}

const DOCS_ORIGIN = "https://docs.z-cms.org";
const DOCS_LOCALES = ["en", "vi", "ja"] as const;

/**
 * A link into z-cms-docs, in the reader's language.
 *
 * Every docs locale is path-prefixed (even the default), so the URL carries the
 * code — falling back to the docs' own default when the admin runs in a language
 * the docs do not have, rather than linking to a 404.
 */
function DocLink({ locale, path, children }: { locale: string; path: string; children: ReactNode }) {
  const code = (DOCS_LOCALES as readonly string[]).includes(locale) ? locale : "vi";
  return (
    <a
      href={`${DOCS_ORIGIN}/${code}/${path}/`}
      target="_blank"
      rel="noreferrer"
      className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-brand-600 hover:underline dark:text-brand-400"
    >
      {children}
      <Icon name="external" className="h-3 w-3" />
    </a>
  );
}

function NewKeyForm({
  passphrase,
  setPassphrase,
  pending,
  onCreate,
  onImport,
}: {
  passphrase: string;
  setPassphrase: (v: string) => void;
  pending: boolean;
  onCreate: () => void;
  onImport: (pem: string) => void;
}) {
  const t = useT();
  const [pem, setPem] = useState("");
  const verdict = passphrase ? assessPassphrase(passphrase) : null;

  return (
    <div className="space-y-3">
      <p className="text-xs z-muted">{t("themeEditor.publish.noKey")}</p>

      <Field label={t("themeEditor.publish.passphrase")} hint={t("themeEditor.publish.passphraseHint")}>
        <Input
          type="password"
          autoComplete="new-password"
          value={passphrase}
          disabled={pending}
          onChange={(e) => setPassphrase(e.target.value)}
        />
      </Field>

      {/* The strength note is not decoration: a stolen blob is an offline guessing
          problem, and the passphrase is what sets its cost. */}
      {verdict ? (
        <p className={verdict.ok ? "text-[11px] text-green-600" : "text-[11px] text-amber-600"}>
          {verdict.message ?? t("themeEditor.publish.passphraseStrong")}
        </p>
      ) : null}

      <Button size="sm" disabled={pending || !verdict?.ok} onClick={onCreate}>
        {t("themeEditor.publish.createKey")}
      </Button>

      <details className="text-xs">
        <summary className="cursor-pointer z-muted">{t("themeEditor.publish.importExisting")}</summary>
        <p className="mt-2 z-muted">{t("themeEditor.publish.importHint")}</p>
        <Textarea
          rows={4}
          className="mt-2 font-mono text-[10px]"
          placeholder="-----BEGIN PRIVATE KEY-----"
          value={pem}
          disabled={pending}
          onChange={(e) => setPem(e.target.value)}
        />
        <Button
          variant="ghost"
          size="sm"
          className="mt-2"
          disabled={pending || !pem || !verdict?.ok}
          onClick={() => onImport(pem)}
        >
          {t("themeEditor.publish.importKey")}
        </Button>
      </details>
    </div>
  );
}

/**
 * The marketplace credential.
 *
 * Write-only by design: the field is always empty on load, because the API never
 * returns the token — it only says whether one is connected. A secret the server
 * hands back to a page is a secret in that page's memory and its devtools.
 */
function MarketplaceToken({
  connected,
  pending,
  onConnect,
  onDisconnect,
}: {
  connected: boolean;
  pending: boolean;
  onConnect: (token: string) => void;
  onDisconnect: () => void;
}) {
  const t = useT();
  const [token, setToken] = useState("");

  if (connected) {
    return (
      <div className="flex items-center justify-between gap-2 rounded border border-neutral-200 p-2 text-xs dark:border-neutral-800">
        <span className="text-green-600">{t("themeEditor.publish.tokenConnected")}</span>
        <Button variant="ghost" size="sm" disabled={pending} onClick={onDisconnect}>
          {t("themeEditor.publish.tokenDisconnect")}
        </Button>
      </div>
    );
  }

  return (
    <details className="text-xs">
      <summary className="cursor-pointer z-muted">{t("themeEditor.publish.connectToken")}</summary>
      <p className="mt-2 z-muted">{t("themeEditor.publish.tokenHint")}</p>
      <Input
        type="password"
        autoComplete="off"
        className="mt-2 font-mono text-[10px]"
        placeholder="zcms_pat_…"
        value={token}
        disabled={pending}
        onChange={(e) => setToken(e.target.value)}
      />
      <Button
        variant="primary"
        size="sm"
        className="mt-2"
        disabled={pending || !token}
        onClick={() => {
          onConnect(token);
          setToken("");
        }}
      >
        {t("themeEditor.publish.tokenConnect")}
      </Button>
    </details>
  );
}

/** Turns the base64 the action returned into a file the browser saves. */
function download(filename: string, base64: string) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
