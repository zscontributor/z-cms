import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPair } from "@zcmsorg/package";

/**
 * Generates the first-party signing keypair.
 *
 * This is the key that decides which code z-cms is willing to run as a built-in.
 * Whoever holds the private half can make plugin-runtime execute anything, with
 * `network:fetch` and the site's API keys — so it is treated like what it is:
 *
 *   - the private half goes to `.keys/`, which is gitignored, at mode 0600, and
 *     belongs in a secret manager rather than on a laptop;
 *   - the public half goes to `keys/zsoft-publisher.pub.pem`, which IS committed,
 *     because pinning it is the entire mechanism.
 *
 * You should not normally run this. It exists for bootstrapping a fork, and for a
 * rotation — and a rotation means every runtime must be given the new
 * FIRST_PARTY_PUBLIC_KEY and every built-in must be re-signed, or they stop running.
 * That is the system working.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

const PRIVATE = path.join(REPO, ".keys/zsoft-publisher-private.pem");
const PUBLIC = path.join(REPO, "keys/zsoft-publisher.pub.pem");

if (fs.existsSync(PRIVATE) && !process.argv.includes("--force")) {
  console.error(
    `\nA private key already exists at ${path.relative(REPO, PRIVATE)}.\n\n` +
      `Overwriting it would orphan every plugin signed with it: they would fail\n` +
      `verification and refuse to run until re-signed AND every runtime was given\n` +
      `the new public key. Pass --force if that is what you mean to do.\n`,
  );
  process.exit(1);
}

const { privateKey, publicKey } = generateKeyPair();

fs.mkdirSync(path.dirname(PRIVATE), { recursive: true });
fs.mkdirSync(path.dirname(PUBLIC), { recursive: true });
fs.writeFileSync(PRIVATE, privateKey, { mode: 0o600 });
fs.writeFileSync(PUBLIC, publicKey);

console.log(`
First-party keypair generated.

  private  ${path.relative(REPO, PRIVATE)}   (gitignored, mode 0600 — MOVE THIS to a secret manager)
  public   ${path.relative(REPO, PUBLIC)}    (commit this)

Every runtime must pin the public half. Put it in .env as a single line:

FIRST_PARTY_PUBLIC_KEY="${publicKey.trim().replace(/\n/g, "\\n")}"

Then re-sign the built-in plugins:  pnpm sign:plugins
`);
