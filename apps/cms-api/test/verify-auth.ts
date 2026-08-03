import path from "node:path";
import { config as loadEnv } from "dotenv";

loadEnv({ path: path.resolve(__dirname, "../../../.env"), quiet: true });

/**
 * Attacks the auth flow against a running cms-api.
 *
 * These are the behaviours that are easy to believe you have and easy to not
 * actually have: a refresh token that is truly single-use, a logout that truly
 * revokes, a login you truly cannot brute-force. Each is asserted against real
 * HTTP, because the only way to know a security control works is to try to beat
 * it.
 *
 *   Usage: node dist/test/verify-auth.js   (after building cms-api, with it running)
 */

const API = (process.env.CMS_API_URL ?? "http://localhost:4100").replace(/\/+$/, "") + "/api/v1";
const EMAIL = process.env.SEED_ADMIN_EMAIL ?? "admin@z-cms.org";
const PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "admin123";

let failures = 0;
function check(name: string, passed: boolean, detail: string) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${name}\n        ${detail}`);
  if (!passed) failures++;
}

async function post(pathname: string, body: unknown) {
  const res = await fetch(`${API}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    /* non-JSON (204) */
  }
  return { status: res.status, json };
}

async function login() {
  const { json } = await post("/auth/login", { email: EMAIL, password: PASSWORD });
  return {
    access: json.accessToken as string,
    refresh: json.refreshToken as string,
  };
}

async function main() {
  console.log("\nAuth verification — attacking the session flow\n");

  // 1. A token replayed the instant after it rotated is one browser racing itself
  //    — a navigation and its prefetch both carrying the cookie pair they left
  //    with. It is answered with a fresh pair, and the session SURVIVES. Killing
  //    the family here is what logged working admins out mid-click.
  //
  //    The theft half of this behaviour — the same replay once the grace window has
  //    passed — is asserted in auth.service.test.ts, which can age the token
  //    instead of sleeping through a window whose length this script cannot know.
  {
    const { refresh: r1 } = await login();
    const rotate = await post("/auth/refresh", { refreshToken: r1 });
    const r2 = rotate.json.refreshToken as string;

    const raced = await post("/auth/refresh", { refreshToken: r1 });
    const stillAlive = await post("/auth/refresh", { refreshToken: r2 });

    check(
      "a refresh token replayed within the race window keeps the session alive",
      rotate.status === 200 && raced.status === 200 && stillAlive.status === 200,
      `rotate=${rotate.status}, raced-replay=${raced.status}, winner's token after=${stillAlive.status} (family intact)`,
    );
  }

  // 2. Logout revokes; the token cannot refresh afterwards. Nor can the token it
  //    was rotated from — a revoked family is never forgiven, race window or not.
  {
    const { refresh: r1 } = await login();
    const rotate = await post("/auth/refresh", { refreshToken: r1 });
    const r2 = rotate.json.refreshToken as string;

    const out = await post("/auth/logout", { refreshToken: r2 });
    const after = await post("/auth/refresh", { refreshToken: r2 });
    const ancestor = await post("/auth/refresh", { refreshToken: r1 });

    check(
      "logout revokes the refresh token, and its whole family with it",
      out.status === 204 && after.status === 401 && ancestor.status === 401,
      `logout=${out.status}, refresh-after=${after.status}, ancestor-after=${ancestor.status}`,
    );
  }

  // 3. A refresh token signed with the wrong key (or garbage) is rejected before
  //    any database work.
  {
    const bad = await post("/auth/refresh", { refreshToken: "not.a.jwt" });
    check(
      "a forged refresh token is rejected",
      bad.status === 401,
      `garbage token → ${bad.status}`,
    );
  }

  // 4. Login is rate limited. A fresh email (its own key) is hammered; the 6th
  //    attempt is blocked regardless of the (wrong) password.
  {
    const email = `bruteforce-${Date.now()}@example.test`;
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) {
      const r = await post("/auth/login", { email, password: "wrong" });
      codes.push(r.status);
    }
    const blocked = codes.slice(5).every((c) => c === 429);
    const allowedFirst = codes.slice(0, 5).every((c) => c === 401);
    check(
      "login is rate limited after 5 attempts",
      allowedFirst && blocked,
      `codes = [${codes.join(", ")}] (first five 401, rest 429)`,
    );
  }

  // 5. The security headers a browser relies on are actually set.
  {
    const res = await fetch(`${API}/health`);
    const csp = res.headers.get("content-security-policy");
    const nosniff = res.headers.get("x-content-type-options");
    const frame = res.headers.get("x-frame-options") ?? res.headers.get("content-security-policy");
    check(
      "security headers are present",
      Boolean(csp) && nosniff === "nosniff" && Boolean(frame),
      `CSP=${csp ? "set" : "MISSING"}, X-Content-Type-Options=${nosniff}`,
    );
  }

  console.log(
    failures === 0
      ? "\nAll auth checks passed — sessions rotate, revoke, and resist brute force.\n"
      : `\n${failures} AUTH CHECK(S) FAILED.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
