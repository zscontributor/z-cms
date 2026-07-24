"use server";

import { revalidatePath } from "next/cache";
import type { MailSettingsDto } from "@zcmsorg/schemas";
import { ApiError, apiFetch, can, getSession } from "@/lib/api";
import { getT } from "@/lib/locale";

export type MailActionResult = { ok: true; message: string } | { ok: false; error: string };

function toMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  return fallback;
}

/**
 * The password field is the whole subtlety here.
 *
 * An empty box means "I did not touch it", not "clear it" — so an empty string is
 * dropped from the payload and the API keeps what it has. That is what lets the
 * form round-trip a saved configuration without ever having been given the secret
 * to put in the box in the first place. Clearing is a separate, explicit checkbox,
 * because "I left a field blank" is not how anyone should discover they have
 * deleted a credential.
 */
export async function saveMailSettingsAction(formData: FormData): Promise<MailActionResult> {
  const t = await getT();

  const user = await getSession();
  if (!user) return { ok: false, error: t("auth.session.expired") };
  if (!can(user, "settings:update")) return { ok: false, error: t("mail.readOnly") };

  const password = String(formData.get("password") ?? "");
  const clearPassword = formData.get("clearPassword") === "on";

  const body: Record<string, unknown> = {
    enabled: formData.get("enabled") === "on",
    host: String(formData.get("host") ?? "").trim(),
    port: Number(formData.get("port") ?? 587),
    secure: formData.get("secure") === "on",
    username: String(formData.get("username") ?? "").trim(),
    fromName: String(formData.get("fromName") ?? "").trim(),
    fromEmail: String(formData.get("fromEmail") ?? "").trim(),
    replyTo: String(formData.get("replyTo") ?? "").trim(),
  };

  // Three-valued on purpose: absent (keep), "" (clear), a string (replace).
  if (clearPassword) body.password = "";
  else if (password) body.password = password;

  try {
    await apiFetch<MailSettingsDto>("/settings/mail", { method: "PATCH", body });
    revalidatePath("/settings/mail");
    return { ok: true, message: t("mail.actions.saved") };
  } catch (error) {
    return { ok: false, error: toMessage(error, t("mail.actions.saveFailed")) };
  }
}

/**
 * Sends a test through the STORED configuration, not the one on screen.
 *
 * Worth being blunt about in the UI (see `mail.actions.saveFirst`): a test that
 * silently used the unsaved form values would tell an operator their new server
 * works, and then the site would go on sending through the old one.
 */
export async function sendTestMailAction(formData: FormData): Promise<MailActionResult> {
  const t = await getT();

  const user = await getSession();
  if (!user) return { ok: false, error: t("auth.session.expired") };
  if (!can(user, "mail:send")) return { ok: false, error: t("mail.actions.testDenied") };

  const to = String(formData.get("to") ?? "").trim();

  try {
    const result = await apiFetch<{ ok: boolean; error?: string }>("/settings/mail/test", {
      method: "POST",
      body: { to },
    });

    // A 200 with ok:false is the mail server refusing, not the API failing. It is
    // the single most useful sentence on this screen, so it is shown verbatim.
    revalidatePath("/settings/mail");
    if (!result.ok) {
      return {
        ok: false,
        error: t("mail.actions.testFailed", { error: result.error ?? "" }),
      };
    }
    return { ok: true, message: t("mail.actions.testSent", { to }) };
  } catch (error) {
    return {
      ok: false,
      error: toMessage(error, t("mail.actions.testFailed", { error: "" })),
    };
  }
}
