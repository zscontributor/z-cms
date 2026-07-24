import path from "node:path";
import { config as loadEnv } from "dotenv";

loadEnv({ path: path.resolve(__dirname, "../../../.env"), quiet: true });

/**
 * Attacks user management against a running cms-api.
 *
 * Permissions decide what a role may DO. They cannot decide who it may do it TO,
 * and that gap is where user management goes wrong: `user:invite` without a rank
 * check lets an ADMIN mint an OWNER and inherit the tenant; `user:manage` without
 * a self check lets an OWNER demote themselves out of the product; neither stops
 * the last OWNER being deleted, which leaves a tenant only `psql` can rescue.
 *
 * Those rules live in UsersService, and a rule nobody attacks is a rule nobody
 * knows they have. Each one below is asserted against real HTTP.
 *
 *   Usage: pnpm --filter @zcmsorg/cms-api verify:users   (with cms-api running)
 */

const API = (process.env.CMS_API_URL ?? "http://localhost:4100").replace(/\/+$/, "") + "/api/v1";
const EMAIL = process.env.SEED_ADMIN_EMAIL ?? "admin@z-cms.org";
const PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "admin123";

/** Long enough to satisfy PASSWORD_MIN, which is the point of the constant. */
const NEW_PASSWORD = "correct-horse-battery-staple";

let failures = 0;
function check(name: string, passed: boolean, detail: string) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${name}\n        ${detail}`);
  if (!passed) failures++;
}

interface Res {
  status: number;
  json: Record<string, unknown>;
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
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    /* 204 */
  }
  return { status: res.status, json };
}

async function login(email: string, password: string) {
  const { json } = await call("POST", "/auth/login", { body: { email, password } });
  return {
    access: json.accessToken as string | undefined,
    refresh: json.refreshToken as string | undefined,
  };
}

/** Invite -> accept, the whole way through. Returns the new user's session. */
async function createUser(owner: string, email: string, role: string) {
  const invite = await call("POST", "/users/invitations", {
    token: owner,
    body: { email, role, siteId: null },
  });
  const token = invite.json.token as string;

  const accepted = await call("POST", "/auth/accept-invite", {
    body: { token, name: email.split("@")[0], password: NEW_PASSWORD },
  });

  return {
    inviteStatus: invite.status,
    inviteToken: token,
    acceptStatus: accepted.status,
    access: accepted.json.accessToken as string | undefined,
    refresh: accepted.json.refreshToken as string | undefined,
    id: (accepted.json.user as { id?: string } | undefined)?.id,
  };
}

async function main() {
  console.log("\nUser management verification — attacking the access rules\n");

  const stamp = Date.now();
  const owner = await login(EMAIL, PASSWORD);
  if (!owner.access) {
    console.error(
      `Could not sign in as ${EMAIL}.\n` +
        `  - Is cms-api running, and the database seeded?\n` +
        `  - Or is it the login rate limiter? It allows 5 attempts per email per 15 minutes, ` +
        `so re-running this file in quick succession will lock the seeded admin out of it. ` +
        `Everything below signs in as throwaway accounts precisely to avoid that; this one login is unavoidable.`,
    );
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  // The happy path has to work, or the refusals below prove nothing.
  // -------------------------------------------------------------------------

  const editorEmail = `verify-editor-${stamp}@example.test`;
  const editor = await createUser(owner.access, editorEmail, "EDITOR");
  check(
    "an invitation can be created and redeemed into a working session",
    editor.inviteStatus === 201 && editor.acceptStatus === 201 && Boolean(editor.access),
    `invite=${editor.inviteStatus}, accept=${editor.acceptStatus}, got a token=${Boolean(editor.access)}`,
  );

  const adminEmail = `verify-admin-${stamp}@example.test`;
  const admin = await createUser(owner.access, adminEmail, "ADMIN");

  // -------------------------------------------------------------------------
  // The token is a credential, and behaves like one.
  // -------------------------------------------------------------------------

  {
    const replay = await call("POST", "/auth/accept-invite", {
      body: { token: editor.inviteToken, name: "Thief", password: NEW_PASSWORD },
    });
    check(
      "an invite token is single-use",
      replay.status === 400,
      `redeeming the same token twice => ${replay.status} (a second account must not be mintable from it)`,
    );
  }

  {
    const forged = await call("POST", "/auth/accept-invite", {
      body: { token: "not-a-real-token", name: "Nobody", password: NEW_PASSWORD },
    });
    check(
      "an unknown invite token is refused",
      forged.status === 400,
      `garbage token => ${forged.status}`,
    );
  }

  // -------------------------------------------------------------------------
  // Rule 1: no granting above your own rank. This is the escalation that turns
  // `user:invite` into a way to become OWNER by proxy.
  // -------------------------------------------------------------------------

  {
    const escalate = await call("POST", "/users/invitations", {
      token: admin.access,
      body: { email: `verify-puppet-${stamp}@example.test`, role: "OWNER", siteId: null },
    });
    check(
      "an ADMIN cannot invite an OWNER",
      escalate.status === 403,
      `ADMIN inviting OWNER => ${escalate.status}: ${String(escalate.json.message ?? "")}`,
    );
  }

  {
    // The permission itself: ADMIN holds user:invite but NOT user:manage, so the
    // role-change route must refuse them before any rank rule is consulted.
    const promote = await call("PATCH", `/users/${editor.id}/membership`, {
      token: admin.access,
      body: { role: "ADMIN", siteId: null },
    });
    check(
      "an ADMIN cannot change anyone's role (user:manage is OWNER-only)",
      promote.status === 403,
      `ADMIN changing a role => ${promote.status}`,
    );
  }

  {
    const remove = await call("DELETE", `/users/${editor.id}`, { token: editor.access });
    check(
      "an EDITOR cannot reach user management at all",
      remove.status === 403,
      `EDITOR deleting a user => ${remove.status}`,
    );
  }

  // -------------------------------------------------------------------------
  // Rule 3: not on yourself. Both halves — the promotion and the removal.
  // -------------------------------------------------------------------------

  const me = await call("GET", "/auth/me", { token: owner.access });
  const ownerId = me.json.id as string;

  {
    const selfDemote = await call("PATCH", `/users/${ownerId}/membership`, {
      token: owner.access,
      body: { role: "VIEWER", siteId: null },
    });
    const selfDelete = await call("DELETE", `/users/${ownerId}`, { token: owner.access });
    check(
      "nobody can change their own role or remove themselves",
      selfDemote.status === 403 && selfDelete.status === 403,
      `self-demote=${selfDemote.status}, self-delete=${selfDelete.status}`,
    );
  }

  // -------------------------------------------------------------------------
  // Rule 4: the tenant never runs out of owners.
  //
  // Note what is NOT asserted here — a 400 from `errors.users.lastOwner`. It
  // cannot happen through these routes, and a test pretending otherwise would be
  // green for a reason that does not exist. Removing an OWNER needs
  // `user:manage`, which only an OWNER has, and rule 3 forbids them acting on
  // themselves — so the acting owner is always an owner left standing. That
  // property is what gets asserted, because that is what actually protects the
  // tenant. (The explicit last-owner guard stays in the service as a backstop for
  // the first route that does not go through rule 3.)
  // -------------------------------------------------------------------------

  {
    // Two throwaway OWNERs, so the seeded admin is never the one demoted. That is
    // not squeamishness: a demotion revokes the demoted user's sessions, and
    // signing the seeded admin back in three times would spend the login rate
    // limit (5 per email per 15 minutes) and make this file fail for a reason
    // that has nothing to do with what it is testing.
    const ownerA = await createUser(owner.access, `verify-owner-a-${stamp}@example.test`, "OWNER");
    const ownerB = await createUser(owner.access, `verify-owner-b-${stamp}@example.test`, "OWNER");

    const demote = await call("PATCH", `/users/${ownerA.id}/membership`, {
      token: ownerB.access,
      body: { role: "VIEWER", siteId: null },
    });

    // A is a VIEWER now, and their old session is dead. A fresh one gets them
    // nowhere: they cannot promote themselves back, which is the whole point.
    const demotedAgain = await login(`verify-owner-a-${stamp}@example.test`, NEW_PASSWORD);
    const selfRestore = await call("PATCH", `/users/${ownerA.id}/membership`, {
      token: demotedAgain.access,
      body: { role: "OWNER", siteId: null },
    });

    check(
      "an OWNER can be demoted by another OWNER, and cannot restore themselves afterwards",
      demote.status === 200 && selfRestore.status === 403,
      `demote=${demote.status}, demoted-user-promoting-self=${selfRestore.status}`,
    );

    const selfDrop = await call("DELETE", `/users/${ownerB.id}`, { token: ownerB.access });
    check(
      "an OWNER cannot remove themselves — which is what keeps a tenant from losing its last one",
      selfDrop.status === 403,
      `OWNER deleting themselves => ${selfDrop.status}`,
    );

    for (const id of [ownerA.id, ownerB.id]) {
      if (id) await call("DELETE", `/users/${id}`, { token: owner.access });
    }
  }

  // -------------------------------------------------------------------------
  // A demotion is not advisory: the sessions it takes away are gone at once.
  // -------------------------------------------------------------------------

  {
    const victimEmail = `verify-victim-${stamp}@example.test`;
    const victim = await createUser(owner.access!, victimEmail, "EDITOR");

    const before = await call("GET", "/auth/me", { token: victim.access });

    await call("PATCH", `/users/${victim.id}/membership`, {
      token: owner.access,
      body: { role: "VIEWER", siteId: null },
    });

    const after = await call("GET", "/auth/me", { token: victim.access });
    const refreshAfter = await call("POST", "/auth/refresh", {
      body: { refreshToken: victim.refresh },
    });

    check(
      "a demotion kills the demoted user's live sessions immediately",
      before.status === 200 && after.status === 401 && refreshAfter.status === 401,
      `before=${before.status}, access-token-after=${after.status}, refresh-after=${refreshAfter.status}`,
    );

    await call("DELETE", `/users/${victim.id}`, { token: owner.access });
  }

  // -------------------------------------------------------------------------
  // Changing a password signs you out everywhere — including here.
  // -------------------------------------------------------------------------

  {
    const pwEmail = `verify-pw-${stamp}@example.test`;
    const pw = await createUser(owner.access!, pwEmail, "VIEWER");

    const wrong = await call("POST", "/users/me/password", {
      token: pw.access,
      body: { currentPassword: "definitely-not-it", newPassword: "another-long-passphrase" },
    });

    const changed = await call("POST", "/users/me/password", {
      token: pw.access,
      body: { currentPassword: NEW_PASSWORD, newPassword: "another-long-passphrase" },
    });

    const afterChange = await call("GET", "/auth/me", { token: pw.access });
    const oldPassword = await login(pwEmail, NEW_PASSWORD);
    const newPassword = await login(pwEmail, "another-long-passphrase");

    check(
      "changing a password needs the current one",
      wrong.status === 401,
      `wrong current password => ${wrong.status}`,
    );
    check(
      "changing a password revokes every session and the old password",
      changed.status === 204 &&
        afterChange.status === 401 &&
        !oldPassword.access &&
        Boolean(newPassword.access),
      `change=${changed.status}, old-session=${afterChange.status}, ` +
        `old-password-works=${Boolean(oldPassword.access)}, new-password-works=${Boolean(newPassword.access)}`,
    );

    await call("DELETE", `/users/${pw.id}`, { token: owner.access });
  }

  // -------------------------------------------------------------------------
  // Removal: the person goes, their work stays, their session dies.
  // -------------------------------------------------------------------------

  {
    const goneEmail = `verify-gone-${stamp}@example.test`;
    const gone = await createUser(owner.access!, goneEmail, "AUTHOR");

    const removed = await call("DELETE", `/users/${gone.id}`, { token: owner.access });
    const stillIn = await call("GET", "/auth/me", { token: gone.access });
    const canRefresh = await call("POST", "/auth/refresh", {
      body: { refreshToken: gone.refresh },
    });
    const canLogIn = await login(goneEmail, NEW_PASSWORD);

    check(
      "a removed user cannot use their token, refresh it, or sign in again",
      removed.status === 204 &&
        stillIn.status === 401 &&
        canRefresh.status === 401 &&
        !canLogIn.access,
      `remove=${removed.status}, me=${stillIn.status}, refresh=${canRefresh.status}, ` +
        `login=${canLogIn.access ? "SUCCEEDED" : "refused"}`,
    );
  }

  // -------------------------------------------------------------------------
  // Housekeeping: leave the tenant as we found it.
  // -------------------------------------------------------------------------

  for (const id of [editor.id, admin.id]) {
    if (id) await call("DELETE", `/users/${id}`, { token: owner.access });
  }

  const invitations = await call("GET", "/users/invitations", { token: owner.access });
  const leftovers = (invitations.json as unknown as { email: string }[] | undefined);
  const mine = Array.isArray(leftovers)
    ? leftovers.filter((i) => i.email.includes(`-${stamp}@`))
    : [];
  check(
    "every invitation created by this run was redeemed (none left pending)",
    mine.length === 0,
    `${mine.length} pending invitation(s) from this run`,
  );

  console.log(
    failures === 0
      ? "\nAll user-management rules hold.\n"
      : `\n${failures} check(s) FAILED.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
