import path from "node:path";
import { config as loadEnv } from "dotenv";

loadEnv({ path: path.resolve(__dirname, "../../../.env"), quiet: true });

import { codeForStep, currentStep } from "../src/auth/totp";

/**
 * Attacks the second factor against a running cms-api.
 *
 * The unit tests prove the ALGORITHM is RFC-correct. That is not the same as
 * proving the FEATURE is secure, and the gap between them is where every real
 * 2FA bug lives: a password that still returns tokens; a challenge ticket that
 * works as an access token; a code that can be replayed inside its own 30-second
 * window; a six-digit secret with no ceiling on guesses. None of those are
 * visible from inside a unit test, and all of them are asserted here, over real
 * HTTP, against a real database.
 *
 *   Usage: pnpm --filter @zcmsorg/cms-api verify:mfa   (with cms-api running)
 */

const API = (process.env.CMS_API_URL ?? "http://localhost:4100").replace(/\/+$/, "") + "/api/v1";
const EMAIL = process.env.SEED_ADMIN_EMAIL ?? "admin@z-cms.org";
const PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "admin123";
const NEW_PASSWORD = "correct-horse-battery-staple";

let failures = 0;
function check(name: string, passed: boolean, detail: string) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${name}\n        ${detail}`);
  if (!passed) failures++;
}

interface Res {
  status: number;
  json: Record<string, any>;
}

async function call(
  method: string,
  pathname: string,
  options: { token?: string; body?: unknown } = {},
): Promise<Res> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.token) headers.authorization = `Bearer ${options.token}`;

  const res = await fetch(`${API}${pathname}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await res.text();
  let json: Record<string, any> = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    /* 204 */
  }
  return { status: res.status, json };
}

const login = (email: string, password: string) =>
  call("POST", "/auth/login", { body: { email, password } });

/** The code an authenticator would be showing right now for this secret. */
const now = (secret: string) => codeForStep(secret, currentStep());

/**
 * Waits for the TOTP window to turn over.
 *
 * Needed because enrollment CONSUMES the step it was proven with — replay
 * protection spans enrollment, so the six digits still on the user's screen the
 * moment they finish setting 2FA up cannot then be used to sign in. Correct, and
 * the reason this file has to spend up to thirty seconds waiting rather than
 * asserting a code works twice.
 */
async function nextStep(): Promise<void> {
  const start = currentStep();
  while (currentStep() === start) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function main() {
  console.log("\nTwo-factor verification — attacking the second factor\n");

  const stamp = Date.now();
  const owner = await login(EMAIL, PASSWORD);
  if (!owner.json.accessToken) {
    console.error(
      `Could not sign in as ${EMAIL}. Is cms-api running and seeded? ` +
        `(Or is it the login rate limiter — 5 per email per 15 minutes?)`,
    );
    process.exit(1);
  }
  const ownerToken: string = owner.json.accessToken;

  // A throwaway account to enroll. The seeded admin is left alone: turning 2FA on
  // for it would leave the OTHER verify scripts unable to log in.
  const email = `verify-mfa-${stamp}@example.test`;
  const invite = await call("POST", "/users/invitations", {
    token: ownerToken,
    body: { email, role: "EDITOR", siteId: null },
  });
  const accepted = await call("POST", "/auth/accept-invite", {
    body: { token: invite.json.token, name: "MFA Subject", password: NEW_PASSWORD },
  });
  const userId: string = accepted.json.user.id;
  let session: string = accepted.json.accessToken;

  // -------------------------------------------------------------------------
  // Enrollment is two steps, and the gap between them is load-bearing.
  // -------------------------------------------------------------------------

  const setup = await call("POST", "/users/me/2fa/setup", { token: session });
  const secret: string = setup.json.secret;

  {
    // A secret that was generated but never proven must NOT be protecting the
    // account: otherwise closing the tab before scanning the QR locks you out
    // with a factor that exists nowhere in the world.
    const stillNoMfa = await login(email, NEW_PASSWORD);

    check(
      "generating a secret does not switch 2FA on — the account still logs in with a password",
      setup.status === 200 &&
        typeof secret === "string" &&
        setup.json.otpauthUrl?.startsWith("otpauth://totp/") &&
        Boolean(stillNoMfa.json.accessToken),
      `setup=${setup.status}, login-still-returns-tokens=${Boolean(stillNoMfa.json.accessToken)}`,
    );
  }

  {
    const wrong = await call("POST", "/users/me/2fa/enable", {
      token: session,
      body: { code: "000000" },
    });
    check(
      "enabling refuses a code the authenticator did not produce",
      wrong.status === 401,
      `enable with a wrong code => ${wrong.status}`,
    );
  }

  const enabled = await call("POST", "/users/me/2fa/enable", {
    token: session,
    body: { code: now(secret) },
  });
  const recoveryCodes: string[] = enabled.json.recoveryCodes ?? [];

  check(
    "a correct code switches 2FA on and issues 10 recovery codes",
    enabled.status === 200 && recoveryCodes.length === 10,
    `enable=${enabled.status}, ${recoveryCodes.length} recovery code(s)`,
  );

  // Enrollment burned the step it was proven with, so the digits still on the
  // user's screen are already spent. Wait for the window to turn over.
  await nextStep();

  // -------------------------------------------------------------------------
  // THE claim. If this one fails, nothing else here matters.
  // -------------------------------------------------------------------------

  const challenged = await login(email, NEW_PASSWORD);

  check(
    "the correct password alone NO LONGER returns tokens — only a challenge",
    challenged.status === 200 &&
      challenged.json.mfaRequired === true &&
      typeof challenged.json.challengeToken === "string" &&
      challenged.json.accessToken === undefined &&
      challenged.json.refreshToken === undefined,
    `login => mfaRequired=${challenged.json.mfaRequired}, ` +
      `accessToken=${challenged.json.accessToken === undefined ? "absent" : "PRESENT"}`,
  );

  const challenge: string = challenged.json.challengeToken;

  {
    // The ticket proves a password was checked. It must not be a session — an
    // endpoint that accepted it as a bearer token would make the second factor
    // decorative.
    const asBearer = await call("GET", "/auth/me", { token: challenge });
    check(
      "the challenge ticket is not usable as an access token",
      asBearer.status === 401,
      `GET /auth/me with the challenge => ${asBearer.status}`,
    );
  }

  {
    const wrong = await call("POST", "/auth/mfa/verify", {
      body: { challengeToken: challenge, code: "000000" },
    });
    check(
      "a wrong code does not complete the login",
      wrong.status === 401,
      `verify with a wrong code => ${wrong.status}`,
    );
  }

  /**
   * Everything below reuses that ONE challenge, and that is a claim about the
   * design as much as a way to stay under the login rate limiter (5 per email per
   * 15 minutes — /auth/login is brute-forceable and verify-auth.ts proves the cap
   * is real).
   *
   * The ticket is a stateless JWT and is deliberately NOT consumed by a failed
   * code: a typo must cost a retry, not the password. What it can never do is
   * mint a session on its own, and that is asserted above.
   */
  const verify = (code: string, ticket: string = challenge) =>
    call("POST", "/auth/mfa/verify", { body: { challengeToken: ticket, code } });

  // -------------------------------------------------------------------------
  // Replay. A TOTP code is valid for its whole 30-second window — long enough to
  // be read over a shoulder and used again.
  // -------------------------------------------------------------------------

  const code = now(secret);
  const first = await verify(code);
  session = first.json.accessToken;

  {
    const replay = await verify(code);
    check(
      "a code completes a login exactly once — the same code cannot be replayed",
      first.status === 200 && Boolean(session) && replay.status === 401,
      `first use=${first.status}, same code again=${replay.status} (inside its own 30s window)`,
    );
  }

  // -------------------------------------------------------------------------
  // Recovery codes: single-use, and enough to get in without the phone.
  // -------------------------------------------------------------------------

  {
    const [recovery] = recoveryCodes;

    const withRecovery = await verify(recovery);
    const reuse = await verify(recovery);

    check(
      "a recovery code signs you in, and is then spent",
      withRecovery.status === 200 && Boolean(withRecovery.json.accessToken) && reuse.status === 401,
      `first use=${withRecovery.status}, second use=${reuse.status}`,
    );

    // Case and hyphen are normalised at the hash: the person typing one of these
    // has just lost their phone and is having a bad enough day.
    const messy = recoveryCodes[1].toLowerCase().replace("-", "");
    const loose = await verify(messy);
    check(
      "a recovery code is accepted lowercase and without its hyphen",
      loose.status === 200,
      `"${messy}" => ${loose.status}`,
    );

    session = loose.json.accessToken ?? session;
  }

  // -------------------------------------------------------------------------
  // Disabling takes BOTH factors.
  // -------------------------------------------------------------------------

  {
    const codeOnly = await call("POST", "/users/me/2fa/disable", {
      token: session,
      body: { password: "not-the-password", code: now(secret) },
    });
    check(
      "2FA cannot be turned off with a code alone — the password is required too",
      codeOnly.status === 401,
      `disable with a valid code but a wrong password => ${codeOnly.status}`,
    );

    const passwordOnly = await call("POST", "/users/me/2fa/disable", {
      token: session,
      body: { password: NEW_PASSWORD, code: "000000" },
    });
    check(
      "2FA cannot be turned off with the password alone — a code is required too",
      passwordOnly.status === 401,
      `disable with the right password but a wrong code => ${passwordOnly.status}`,
    );
  }

  // -------------------------------------------------------------------------
  // Brute force. Six digits is a million, and an attacker who already has the
  // password only needs one of them.
  //
  // LAST, because it deliberately locks the account for fifteen minutes and there
  // is no way for a client to clear that — which is the whole point, and is
  // asserted below rather than worked around.
  // -------------------------------------------------------------------------

  {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 8; attempt++) {
      const res = await verify(String(100000 + attempt));
      statuses.push(res.status);
    }

    // Not "the first five are 401": the two failed `disable` attempts above are on
    // the same account counter, and hard-coding where the wall falls would be
    // asserting an accident. What matters is that a wall falls at all, and that
    // nothing gets through it afterwards.
    const wall = statuses.indexOf(403);
    const sealed = wall !== -1 && statuses.slice(wall).every((status) => status === 403);

    check(
      "guessing hits a wall: the account stops answering, and stays stopped",
      sealed,
      `statuses = [${statuses.join(", ")}] — first 403 at attempt ${wall + 1}, and every one after it`,
    );

    // The cap is on the ACCOUNT, not on the guess. An attacker cannot spend five
    // misses and then land the sixth — and neither, for the fifteen minutes it
    // lasts, can the real user. That cost is the price of the protection.
    const rightCodeWhileLocked = await verify(now(secret));
    check(
      "while locked out, even a CORRECT code is refused — the cap is on the account",
      rightCodeWhileLocked.status === 403,
      `correct code during the lockout => ${rightCodeWhileLocked.status}`,
    );

    const goodRecoveryWhileLocked = await verify(recoveryCodes[2]);
    check(
      "and so is a recovery code — the lockout is not something a client can talk its way out of",
      goodRecoveryWhileLocked.status === 403,
      `unused recovery code during the lockout => ${goodRecoveryWhileLocked.status}`,
    );
  }

  // -------------------------------------------------------------------------
  // The escape hatch, for the phone at the bottom of a river — and for the user
  // who has just locked themselves out of their own account, above.
  // -------------------------------------------------------------------------

  {
    const reset = await call("DELETE", `/users/${userId}/2fa`, { token: ownerToken });
    const afterReset = await login(email, NEW_PASSWORD);

    check(
      "an OWNER can reset someone's 2FA, and they are back to a password login",
      reset.status === 204 &&
        afterReset.json.mfaRequired === undefined &&
        Boolean(afterReset.json.accessToken),
      `reset=${reset.status}, login-after=${afterReset.json.accessToken ? "tokens" : "still challenged"}`,
    );

    const spent = await verify(now(secret));
    check(
      "the old secret and its challenges are dead after a reset",
      spent.status === 401,
      `verifying against the reset account's old secret => ${spent.status}`,
    );
  }

  // Housekeeping.
  await call("DELETE", `/users/${userId}`, { token: ownerToken });

  console.log(
    failures === 0
      ? "\nThe second factor holds: a stolen password is not a session.\n"
      : `\n${failures} check(s) FAILED.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
