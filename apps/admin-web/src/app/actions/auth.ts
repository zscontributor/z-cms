"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  isMfaChallenge,
  LoginSchema,
  PASSWORD_MIN,
  type AuthResult,
  type LoginResult,
} from "@zcmsorg/schemas";
import { API_BASE } from "@/lib/api";
import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  SITE_COOKIE,
  accessCookieOptions,
  refreshCookieOptions,
} from "@/lib/cookies";
import { getT } from "@/lib/locale";

export interface LoginState {
  error?: string;
  fieldErrors?: Partial<Record<"email" | "password" | "code", string>>;
  /**
   * Present when the password was right and the account has a second factor.
   *
   * It lives in the form state, not in a cookie: it is a five-minute ticket for
   * one specific submission, and putting it in a cookie would leave a
   * password-was-correct token lying around the browser long after the login it
   * belonged to was abandoned.
   */
  challengeToken?: string;
}

/**
 * Only ever bounce to a path on this origin. A `next` of `//evil.example` is a
 * protocol-relative URL, and it is the classic open-redirect.
 */
function safeNext(next: string): string {
  return next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

async function establishSession(auth: AuthResult, next: string): Promise<never> {
  const store = await cookies();
  store.set(ACCESS_TOKEN_COOKIE, auth.accessToken, accessCookieOptions);
  store.set(REFRESH_TOKEN_COOKIE, auth.refreshToken, refreshCookieOptions);
  // A new login must not inherit the previous account's site selection.
  store.delete(SITE_COOKIE);

  revalidatePath("/", "layout");
  redirect(safeNext(next));
}

/**
 * The password step.
 *
 * It does not always end in a session any more. When the account has a second
 * factor, the API answers with a challenge instead of tokens, and the form
 * switches to asking for a code — see `verifyMfaAction`. No cookie is written
 * until the second factor has been proven, so an attacker holding only the
 * password gets exactly as far as a screen asking for something they do not have.
 */
export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const t = await getT();

  const parsed = LoginSchema.safeParse({
    email: String(formData.get("email") ?? "").trim(),
    password: String(formData.get("password") ?? ""),
  });

  if (!parsed.success) {
    const fieldErrors: LoginState["fieldErrors"] = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (key === "email") fieldErrors.email = t("auth.errors.invalidEmail");
      if (key === "password") fieldErrors.password = t("auth.errors.passwordRequired");
    }
    return { fieldErrors };
  }

  let result: LoginResult;
  try {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed.data),
      cache: "no-store",
    });

    if (res.status === 401 || res.status === 400) {
      return { error: t("auth.errors.invalidCredentials") };
    }
    if (!res.ok) {
      return { error: t("auth.errors.loginFailed", { status: res.status }) };
    }
    result = (await res.json()) as LoginResult;
  } catch {
    return { error: t("auth.errors.serverUnreachable") };
  }

  if (isMfaChallenge(result)) {
    return { challengeToken: result.challengeToken };
  }

  return establishSession(result, String(formData.get("next") ?? "/"));
}

/**
 * The code step.
 *
 * The challenge token names the account — the client never gets to say who it is
 * claiming to be here — so a code can only ever be tried against the account
 * whose password was just checked.
 */
export async function verifyMfaAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const t = await getT();

  const challengeToken = String(formData.get("challengeToken") ?? "");
  if (!challengeToken) return { error: t("auth.mfa.challengeExpired") };

  const code = String(formData.get("code") ?? "").trim();
  if (!code) {
    return { challengeToken, fieldErrors: { code: t("auth.mfa.codeRequired") } };
  }

  let auth: AuthResult;
  try {
    const res = await fetch(`${API_BASE}/auth/mfa/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challengeToken, code }),
      cache: "no-store",
    });

    // A 403 is the account's own throttle: five wrong codes and it stops
    // accepting them. Not the same sentence as "that code is wrong" — being told
    // to try again when trying again cannot work is worse than being told nothing.
    if (res.status === 403) {
      return { challengeToken, error: t("auth.mfa.tooManyAttempts") };
    }
    if (res.status === 401) {
      const body: unknown = await res.json().catch(() => undefined);
      const message =
        body && typeof body === "object" && typeof (body as { message?: unknown }).message === "string"
          ? (body as { message: string }).message
          : t("auth.mfa.invalidCode");
      // The challenge is kept: a wrong code should cost a retry, not the password.
      return { challengeToken, fieldErrors: { code: message } };
    }
    if (!res.ok) {
      return { challengeToken, error: t("auth.errors.loginFailed", { status: res.status }) };
    }

    auth = (await res.json()) as AuthResult;
  } catch {
    return { challengeToken, error: t("auth.errors.serverUnreachable") };
  }

  return establishSession(auth, String(formData.get("next") ?? "/"));
}

export interface AcceptInviteState {
  error?: string;
  fieldErrors?: Partial<Record<"name" | "password" | "confirmPassword", string>>;
}

/**
 * Redeems an invitation and signs the new user in.
 *
 * It talks to the API with a bare `fetch`, not `apiFetch`, for the same reason
 * `loginAction` does: there is no session yet, so the bearer token and the
 * refresh-and-retry machinery have nothing to work with.
 *
 * The password is confirmed here rather than by the API. A mismatch is not a
 * disagreement about what is valid — both halves are perfectly good passwords —
 * it is a typo, and the only place that can be caught is where both fields exist.
 */
export async function acceptInviteAction(
  _prev: AcceptInviteState,
  formData: FormData,
): Promise<AcceptInviteState> {
  const t = await getT();

  const token = String(formData.get("token") ?? "");
  if (!token) return { error: t("auth.acceptInvite.missingToken") };

  const name = String(formData.get("name") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");

  const fieldErrors: AcceptInviteState["fieldErrors"] = {};
  if (!name) fieldErrors.name = t("auth.acceptInvite.nameRequired");
  if (password.length < PASSWORD_MIN) {
    fieldErrors.password = t("auth.acceptInvite.passwordTooShort", { min: PASSWORD_MIN });
  }
  if (password !== confirmPassword) {
    fieldErrors.confirmPassword = t("auth.acceptInvite.passwordMismatch");
  }
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };

  let auth: AuthResult;
  try {
    const res = await fetch(`${API_BASE}/auth/accept-invite`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, name, password }),
      cache: "no-store",
    });

    if (!res.ok) {
      // The API's sentence, when it has one — "this invitation link is not valid"
      // and "this address already has an account, sign in instead" are the two
      // answers that actually tell the invitee what to do next.
      const body: unknown = await res.json().catch(() => undefined);
      const message =
        body && typeof body === "object" && typeof (body as { message?: unknown }).message === "string"
          ? (body as { message: string }).message
          : t("auth.acceptInvite.failed");
      return { error: message };
    }

    auth = (await res.json()) as AuthResult;
  } catch {
    return { error: t("auth.errors.serverUnreachable") };
  }

  const store = await cookies();
  store.set(ACCESS_TOKEN_COOKIE, auth.accessToken, accessCookieOptions);
  store.set(REFRESH_TOKEN_COOKIE, auth.refreshToken, refreshCookieOptions);
  // Whoever was signed in on this browser before, it was not this person.
  store.delete(SITE_COOKIE);

  revalidatePath("/", "layout");
  redirect("/");
}

export async function logoutAction(): Promise<void> {
  const store = await cookies();
  const refreshToken = store.get(REFRESH_TOKEN_COOKIE)?.value;

  // Deleting the cookies only makes THIS browser forget the session. The refresh
  // token would still be valid for anyone holding a copy of it — which is the
  // whole scenario logout exists for. Tell the API to revoke the family.
  if (refreshToken) {
    try {
      await fetch(`${API_BASE}/auth/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
        cache: "no-store",
      });
    } catch {
      // The API being unreachable must not trap the user in a session they asked
      // to leave: clear the cookies regardless. The token dies at its TTL.
    }
  }

  store.delete(ACCESS_TOKEN_COOKIE);
  store.delete(REFRESH_TOKEN_COOKIE);
  store.delete(SITE_COOKIE);
  revalidatePath("/", "layout");
  redirect("/login");
}
