"use server";

import { ApiError, apiFetch, can, getSession } from "@/lib/api";
import { getT } from "@/lib/locale";
import type { DraftActionResult } from "./theme-draft";

/**
 * The server's half of the author's identity: it stores a blob and hands it back.
 *
 * Every value that crosses this file is either public (the SPKI PEM) or ciphertext
 * nothing here can open. The passphrase does not appear — not as a parameter, not
 * as a return, not in a log. If it ever needs to, the design has gone wrong: the
 * whole point is that compromising this server does not compromise the identity.
 */

export interface WrappedKeyDto {
  publicKeyPem: string;
  wrappedPrivateKey: string;
  kdfSalt: string;
  kdfIv: string;
  kdf: string;
  kdfIterations: number;
  /** Whether a marketplace token is connected. Never the token — see the API's DTO. */
  hasMarketplaceToken: boolean;
  createdAt: string;
  updatedAt: string;
}

/** What a client may SEND — the wrapped key, and nothing the server derives. */
export type PutWrappedKey = Pick<
  WrappedKeyDto,
  "publicKeyPem" | "wrappedPrivateKey" | "kdfSalt" | "kdfIv" | "kdf" | "kdfIterations"
>;

function toMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  return fallback;
}

/** Null rather than an error when there is no key: "not set up yet" is a state. */
export async function getPublisherKeyAction(): Promise<DraftActionResult<WrappedKeyDto | null>> {
  const t = await getT();
  const user = await getSession();
  if (!user) return { ok: false, error: t("auth.session.expired") };
  if (!can(user, "theme:author")) return { ok: false, error: t("themeEditor.errors.denied") };

  try {
    return { ok: true, data: await apiFetch<WrappedKeyDto>("/publisher-key") };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { ok: true, data: null };
    return { ok: false, error: toMessage(error, t("themeEditor.publish.keyLoadFailed")) };
  }
}

/**
 * Stores an already-wrapped key.
 *
 * The wrapping happened in the browser. This takes the result — there is no
 * variant of this action that takes a private key and wraps it here, and adding one
 * would put the author's identity on a server that has no use for it.
 */
export async function savePublisherKeyAction(
  // The wrapped key only. `hasMarketplaceToken` is something the API reports, not
  // something a client sets — it is derived from a column this body never touches.
  wrapped: PutWrappedKey,
): Promise<DraftActionResult<WrappedKeyDto>> {
  const t = await getT();
  const user = await getSession();
  if (!user) return { ok: false, error: t("auth.session.expired") };
  if (!can(user, "theme:author")) return { ok: false, error: t("themeEditor.errors.denied") };

  try {
    return { ok: true, data: await apiFetch<WrappedKeyDto>("/publisher-key", {
      method: "PUT",
      body: wrapped,
    }) };
  } catch (error) {
    return { ok: false, error: toMessage(error, t("themeEditor.publish.keySaveFailed")) };
  }
}

export async function forgetPublisherKeyAction(): Promise<DraftActionResult> {
  const t = await getT();
  const user = await getSession();
  if (!user) return { ok: false, error: t("auth.session.expired") };
  if (!can(user, "theme:author")) return { ok: false, error: t("themeEditor.errors.denied") };

  try {
    await apiFetch<unknown>("/publisher-key", { method: "DELETE" });
    return { ok: true, data: undefined };
  } catch (error) {
    return { ok: false, error: toMessage(error, t("themeEditor.publish.keyDeleteFailed")) };
  }
}

/**
 * Hands the browser's signature to cms-api and gets the finished package back.
 *
 * The bytes come back base64: a server action returns JSON, and a .zcms is binary.
 * It costs a third more over the wire for a file that is measured in hundreds of
 * kilobytes — worth it to keep the whole flow inside the action layer the rest of
 * this admin uses, rather than opening a bespoke route for one download.
 */
export async function sealThemeDraftAction(
  id: string,
  signature: string,
  publicKeyPem: string,
): Promise<DraftActionResult<{ filename: string; base64: string }>> {
  const t = await getT();
  const user = await getSession();
  if (!user) return { ok: false, error: t("auth.session.expired") };
  if (!can(user, "theme:author")) return { ok: false, error: t("themeEditor.errors.denied") };

  try {
    const res = await apiFetch<{ filename: string; base64: string }>(
      `/theme-drafts/${encodeURIComponent(id)}/seal`,
      { method: "POST", body: { signature, publicKeyPem } },
    );
    return { ok: true, data: res };
  } catch (error) {
    return { ok: false, error: toMessage(error, t("themeEditor.publish.sealFailed")) };
  }
}

/**
 * Connects the marketplace account.
 *
 * `theme:publish`, not `theme:author`: this credential speaks for the company
 * upstream, and handing it over is the act of granting that.
 */
export async function connectMarketplaceTokenAction(
  token: string,
): Promise<DraftActionResult> {
  const t = await getT();
  const user = await getSession();
  if (!user) return { ok: false, error: t("auth.session.expired") };
  if (!can(user, "theme:publish")) {
    return { ok: false, error: t("themeEditor.publish.publishDenied") };
  }

  try {
    await apiFetch<unknown>("/publisher-key/marketplace-token", {
      method: "PUT",
      body: { token },
    });
    return { ok: true, data: undefined };
  } catch (error) {
    return { ok: false, error: toMessage(error, t("themeEditor.publish.tokenSaveFailed")) };
  }
}

export async function disconnectMarketplaceTokenAction(): Promise<DraftActionResult> {
  const t = await getT();
  const user = await getSession();
  if (!user) return { ok: false, error: t("auth.session.expired") };
  if (!can(user, "theme:publish")) {
    return { ok: false, error: t("themeEditor.publish.publishDenied") };
  }

  try {
    await apiFetch<unknown>("/publisher-key/marketplace-token", { method: "DELETE" });
    return { ok: true, data: undefined };
  } catch (error) {
    return { ok: false, error: toMessage(error, t("themeEditor.publish.tokenSaveFailed")) };
  }
}

/**
 * Signs, seals and sends — the one click.
 *
 * The signature was made in the browser and arrives here already done. This action
 * never sees a private key, and the endpoint it calls has no field for one.
 */
export async function submitThemeDraftAction(
  id: string,
  signature: string,
  publicKeyPem: string,
): Promise<DraftActionResult<{ id: string; version: string; reviewStatus: string }>> {
  const t = await getT();
  const user = await getSession();
  if (!user) return { ok: false, error: t("auth.session.expired") };
  if (!can(user, "theme:publish")) {
    return { ok: false, error: t("themeEditor.publish.publishDenied") };
  }

  try {
    const res = await apiFetch<{ id: string; version: string; reviewStatus: string }>(
      `/theme-drafts/${encodeURIComponent(id)}/submit`,
      { method: "POST", body: { signature, publicKeyPem } },
    );
    return { ok: true, data: res };
  } catch (error) {
    return { ok: false, error: toMessage(error, t("themeEditor.publish.submitFailed")) };
  }
}
