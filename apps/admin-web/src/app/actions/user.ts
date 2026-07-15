"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import QRCode from "qrcode";
import {
  PASSWORD_MIN,
  type InvitationCreatedDto,
  type Permission,
  type RecoveryCodesDto,
  type Role,
  type TotpSetupDto,
  type UserCreatedDto,
  type UserDto,
} from "@zcmsorg/schemas";
import { ApiError, apiFetch, can, getSession } from "@/lib/api";
import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  SITE_COOKIE,
} from "@/lib/cookies";
import { getT } from "@/lib/locale";

/**
 * Every check here is a *courtesy*, not a control.
 *
 * cms-api re-derives the caller, re-reads their role from the database and
 * applies the whole rule set (no self-management, no granting above your own
 * rank, no removing the last owner) before it touches a row. What these checks
 * buy is a sentence instead of a 403, and a button that does not pretend to
 * work. Deleting them would be rude; relying on them would be a vulnerability.
 */

export type UserActionResult = { ok: true; message: string } | { ok: false; error: string };

export interface InviteState {
  error?: string;
  /** Present exactly once, on the response that created the invitation. */
  created?: InvitationCreatedDto;
}

export interface CreateUserState {
  error?: string;
  created?: UserCreatedDto;
}

export interface ProfileState {
  error?: string;
  message?: string;
}

function toMessage(error: unknown, fallback: string): string {
  // The API's own words when it has some: "this is the last owner", "you cannot
  // grant OWNER", "that address already has an account" are all more useful than
  // anything a generic failure string could say.
  if (error instanceof ApiError) return error.message;
  return fallback;
}

async function guard(permission: Permission): Promise<string | null> {
  const t = await getT();
  const user = await getSession();
  if (!user) return t("auth.session.expired");
  if (!can(user, permission)) return t("admin.users.denied");
  return null;
}

/** A scope arrives from a <select>, where "" is the tenant-wide option. */
function toSiteId(raw: FormDataEntryValue | null): string | null {
  const value = String(raw ?? "").trim();
  return value === "" ? null : value;
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

export async function createUserAction(
  _prev: CreateUserState,
  formData: FormData,
): Promise<CreateUserState> {
  const t = await getT();

  const denied = await guard("user:invite");
  if (denied) return { error: denied };

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const name = String(formData.get("name") ?? "").trim();
  const password = String(formData.get("password") ?? "").trim();

  if (!email.includes("@")) return { error: t("admin.users.invite.emailInvalid") };
  if (!name) return { error: t("auth.acceptInvite.nameRequired") };
  if (password && password.length < PASSWORD_MIN) {
    return { error: t("auth.acceptInvite.passwordHint", { min: PASSWORD_MIN }) };
  }

  try {
    const created = await apiFetch<UserCreatedDto>("/users", {
      method: "POST",
      siteScoped: false,
      body: {
        email,
        name,
        ...(password ? { password } : {}),
        role: String(formData.get("role") ?? "VIEWER") as Role,
        siteId: toSiteId(formData.get("siteId")),
      },
    });

    revalidatePath("/users");
    return { created };
  } catch (error) {
    return { error: toMessage(error, t("admin.users.invite.failed")) };
  }
}

export async function inviteUserAction(
  _prev: InviteState,
  formData: FormData,
): Promise<InviteState> {
  const t = await getT();

  const denied = await guard("user:invite");
  if (denied) return { error: denied };

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!email.includes("@")) return { error: t("admin.users.invite.emailInvalid") };

  try {
    const created = await apiFetch<InvitationCreatedDto>("/users/invitations", {
      method: "POST",
      siteScoped: false,
      body: {
        email,
        role: String(formData.get("role") ?? "VIEWER") as Role,
        siteId: toSiteId(formData.get("siteId")),
      },
    });

    revalidatePath("/users");
    // The token rides back to the form, which shows it once and says so. It is
    // never persisted anywhere on this side — a "recent invitations" list holding
    // live tokens would undo the point of hashing them.
    return { created };
  } catch (error) {
    return { error: toMessage(error, t("admin.users.invite.failed")) };
  }
}

export async function revokeInvitationAction(id: string): Promise<UserActionResult> {
  const t = await getT();

  const denied = await guard("user:invite");
  if (denied) return { ok: false, error: denied };

  try {
    await apiFetch<void>(`/users/invitations/${encodeURIComponent(id)}`, {
      method: "DELETE",
      siteScoped: false,
    });
    revalidatePath("/users");
    return { ok: true, message: t("admin.users.pending.revokeSuccess") };
  } catch (error) {
    return { ok: false, error: toMessage(error, t("admin.users.pending.revokeFailed")) };
  }
}

// ---------------------------------------------------------------------------
// Memberships
// ---------------------------------------------------------------------------

export async function setMembershipAction(
  userId: string,
  role: Role,
  siteId: string | null,
): Promise<UserActionResult> {
  const t = await getT();

  const denied = await guard("user:manage");
  if (denied) return { ok: false, error: denied };

  try {
    const user = await apiFetch<UserDto>(`/users/${encodeURIComponent(userId)}/membership`, {
      method: "PATCH",
      siteScoped: false,
      body: { role, siteId },
    });
    revalidatePath("/users");
    return {
      ok: true,
      message: t("admin.users.role.success", {
        name: user.name,
        role: t(`admin.roles.${role}`),
      }),
    };
  } catch (error) {
    return { ok: false, error: toMessage(error, t("admin.users.role.failed")) };
  }
}

export async function updateUserAction(
  userId: string,
  input: { name: string; avatarUrl: string },
): Promise<UserActionResult> {
  const t = await getT();

  const denied = await guard("user:manage");
  if (denied) return { ok: false, error: denied };

  const name = input.name.trim();
  if (!name) return { ok: false, error: t("auth.acceptInvite.nameRequired") };

  try {
    const user = await apiFetch<UserDto>(`/users/${encodeURIComponent(userId)}`, {
      method: "PATCH",
      siteScoped: false,
      body: { name, avatarUrl: input.avatarUrl.trim() || null },
    });
    revalidatePath("/users");
    return { ok: true, message: t("admin.users.edit.success", { name: user.name }) };
  } catch (error) {
    return { ok: false, error: toMessage(error, t("admin.users.edit.failed")) };
  }
}

export async function removeMembershipAction(
  userId: string,
  membershipId: string,
): Promise<UserActionResult> {
  const t = await getT();

  const denied = await guard("user:manage");
  if (denied) return { ok: false, error: denied };

  try {
    await apiFetch<UserDto>(
      `/users/${encodeURIComponent(userId)}/memberships/${encodeURIComponent(membershipId)}`,
      { method: "DELETE", siteScoped: false },
    );
    revalidatePath("/users");
    return { ok: true, message: t("admin.users.removeRoleDialog.success") };
  } catch (error) {
    return { ok: false, error: toMessage(error, t("admin.users.removeRoleDialog.failed")) };
  }
}

export async function removeUserAction(userId: string, name: string): Promise<UserActionResult> {
  const t = await getT();

  const denied = await guard("user:manage");
  if (denied) return { ok: false, error: denied };

  try {
    await apiFetch<void>(`/users/${encodeURIComponent(userId)}`, {
      method: "DELETE",
      siteScoped: false,
    });
    revalidatePath("/users");
    return { ok: true, message: t("admin.users.removeDialog.success", { name }) };
  } catch (error) {
    return { ok: false, error: toMessage(error, t("admin.users.removeDialog.failed")) };
  }
}

// ---------------------------------------------------------------------------
// Your own account
// ---------------------------------------------------------------------------

export async function updateProfileAction(
  _prev: ProfileState,
  formData: FormData,
): Promise<ProfileState> {
  const t = await getT();

  const user = await getSession();
  if (!user) return { error: t("auth.session.expired") };

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: t("auth.acceptInvite.nameRequired") };

  const avatarUrl = String(formData.get("avatarUrl") ?? "").trim();

  try {
    await apiFetch<UserDto>("/users/me", {
      method: "PATCH",
      siteScoped: false,
      // Empty means "clear it", which is a null, not an omission — the API tells
      // the two apart and would otherwise leave the old avatar in place forever.
      body: { name, avatarUrl: avatarUrl || null },
    });
    revalidatePath("/", "layout");
    return { message: t("admin.profile.details.success") };
  } catch (error) {
    return { error: toMessage(error, t("admin.profile.details.failed")) };
  }
}

// ---------------------------------------------------------------------------
// Two-factor authentication, on your own account
// ---------------------------------------------------------------------------

export type TotpSetupResult =
  | { ok: true; setup: TotpSetupDto; qrSvg: string }
  | { ok: false; error: string };

export type RecoveryCodesResult =
  | { ok: true; codes: string[] }
  | { ok: false; error: string };

/**
 * Begins enrollment, and renders the QR here on the server.
 *
 * Server-side, as inline SVG, for two reasons. The CSP forbids remote images and
 * would have to be loosened for any QR service — and handing the secret to a
 * third party to draw a picture of it is not a trade anyone should make. And an
 * SVG needs no <img>, no data: URI, and no client-side library in the bundle.
 */
export async function setupTotpAction(): Promise<TotpSetupResult> {
  const t = await getT();

  const user = await getSession();
  if (!user) return { ok: false, error: t("auth.session.expired") };

  try {
    const setup = await apiFetch<TotpSetupDto>("/users/me/2fa/setup", {
      method: "POST",
      siteScoped: false,
    });

    const qrSvg = await QRCode.toString(setup.otpauthUrl, {
      type: "svg",
      margin: 1,
      errorCorrectionLevel: "M",
      // Black on transparent: the card behind it is white in light mode and dark
      // in dark mode, and a scanner needs contrast, not a colour scheme. The
      // component paints a white plate under it.
      color: { dark: "#000000", light: "#0000" },
    });

    return { ok: true, setup, qrSvg };
  } catch (error) {
    return { ok: false, error: toMessage(error, t("admin.profile.twoFactor.setupFailed")) };
  }
}

export async function enableTotpAction(code: string): Promise<RecoveryCodesResult> {
  const t = await getT();

  const user = await getSession();
  if (!user) return { ok: false, error: t("auth.session.expired") };

  try {
    const result = await apiFetch<RecoveryCodesDto>("/users/me/2fa/enable", {
      method: "POST",
      siteScoped: false,
      body: { code: code.trim() },
    });
    revalidatePath("/", "layout");
    return { ok: true, codes: result.recoveryCodes };
  } catch (error) {
    return { ok: false, error: toMessage(error, t("auth.mfa.invalidCode")) };
  }
}

export async function disableTotpAction(
  password: string,
  code: string,
): Promise<UserActionResult> {
  const t = await getT();

  const user = await getSession();
  if (!user) return { ok: false, error: t("auth.session.expired") };

  try {
    await apiFetch<void>("/users/me/2fa/disable", {
      method: "POST",
      siteScoped: false,
      body: { password, code: code.trim() },
    });
    revalidatePath("/", "layout");
    return { ok: true, message: t("admin.profile.twoFactor.disabled") };
  } catch (error) {
    return { ok: false, error: toMessage(error, t("admin.profile.twoFactor.disableFailed")) };
  }
}

export async function regenerateRecoveryCodesAction(
  password: string,
): Promise<RecoveryCodesResult> {
  const t = await getT();

  const user = await getSession();
  if (!user) return { ok: false, error: t("auth.session.expired") };

  try {
    const result = await apiFetch<RecoveryCodesDto>("/users/me/2fa/recovery-codes", {
      method: "POST",
      siteScoped: false,
      body: { password },
    });
    return { ok: true, codes: result.recoveryCodes };
  } catch (error) {
    return {
      ok: false,
      error: toMessage(error, t("admin.profile.twoFactor.regenerateFailed")),
    };
  }
}

/**
 * An administrator resetting someone else's second factor.
 *
 * This is a bypass, and the UI says so before it happens. The API enforces the
 * rest — OWNER only, never on yourself, never on someone who outranks you.
 */
export async function resetTwoFactorAction(
  userId: string,
  name: string,
): Promise<UserActionResult> {
  const t = await getT();

  const denied = await guard("user:manage");
  if (denied) return { ok: false, error: denied };

  try {
    await apiFetch<void>(`/users/${encodeURIComponent(userId)}/2fa`, {
      method: "DELETE",
      siteScoped: false,
    });
    revalidatePath("/users");
    return { ok: true, message: t("admin.users.resetTwoFactorDialog.success", { name }) };
  } catch (error) {
    return {
      ok: false,
      error: toMessage(error, t("admin.users.resetTwoFactorDialog.failed")),
    };
  }
}

/**
 * Changes the password and lands the user on /login.
 *
 * The redirect is not a courtesy — the API kills every session on a password
 * change, this one included, so the cookies in this browser are pointing at a
 * revoked family the moment it returns. Clearing them here is the difference
 * between "you have been signed out, sign in again" and a confusing tour of the
 * app's 401 paths.
 */
export async function changePasswordAction(
  _prev: ProfileState,
  formData: FormData,
): Promise<ProfileState> {
  const t = await getT();

  const user = await getSession();
  if (!user) return { error: t("auth.session.expired") };

  const currentPassword = String(formData.get("currentPassword") ?? "");
  const newPassword = String(formData.get("newPassword") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");

  if (newPassword.length < PASSWORD_MIN) {
    return { error: t("admin.profile.password.tooShort", { min: PASSWORD_MIN }) };
  }
  if (newPassword !== confirmPassword) {
    return { error: t("admin.profile.password.mismatch") };
  }

  try {
    await apiFetch<void>("/users/me/password", {
      method: "POST",
      siteScoped: false,
      body: { currentPassword, newPassword },
    });
  } catch (error) {
    return { error: toMessage(error, t("admin.profile.password.failed")) };
  }

  const store = await cookies();
  store.delete(ACCESS_TOKEN_COOKIE);
  store.delete(REFRESH_TOKEN_COOKIE);
  store.delete(SITE_COOKIE);

  revalidatePath("/", "layout");
  redirect("/login");
}
