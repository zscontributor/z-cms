"use client";

import { useEffect, useState, useTransition } from "react";
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
import { Field, Input, Textarea } from "@/components/ui/field";
import { useT } from "@/lib/i18n-provider";

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
    <section className="space-y-3 border-t border-neutral-200 p-4 dark:border-neutral-800">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
        {t("themeEditor.publish.heading")}
      </h3>

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
              variant="ghost"
              size="sm"
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
        variant="ghost"
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
