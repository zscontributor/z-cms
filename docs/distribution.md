# Packaging & distribution

This is what turns the marketplace from "a catalogue you can look at" into "a
catalogue you can install from": themes and plugins become **signed packages**,
downloaded and loaded at runtime.

## Where the marketplace lives

| | |
| --- | --- |
| Project | **https://z-cms.org** |
| Marketplace | **https://marketplace.z-cms.org** |

The marketplace **is** a separate service, and a private one. `marketplace.z-cms.org`
is the operator product Z-SOFT runs — publishing, review, counter-signing, and the
signed revocation feed — and it lives in its own repository (`z-cms-marketplace`),
not in this open-source tree. It holds the Z-SOFT signing key. See "One marketplace,
many instances" for why that split is a product/operations decision and **not** a
security one.

What ships in THIS repo is the consumer half. A cms-api instance browses that
marketplace, installs from it, and enforces its revocation feed — but it never
signs anything and holds no private key. The key a runtime verifies against is the
one **pinned in its own environment** (`MARKETPLACE_PUBLIC_KEY`), not a name
hard-coded in the source: pin `marketplace.z-cms.org`'s key to trust the public
marketplace, or pin your own registry's key to trust a private one. The trust
boundary is a key, not a hostname — a hostname could be spoofed, and a pinned key
cannot.

## The problem it solves

`themes/default` used to be **statically imported** into site-runtime. Adding a
theme meant editing code and redeploying — exactly the thing an end user of a CMS
should never have to do.

Installing a theme is now **data, not a deploy**. Verified end to end: pack the
Aurora theme, upload it, activate it, and **the same running site-runtime
process** changes its entire appearance — no restart, no rebuild.

## The `.zcms` format

A gzipped tar containing exactly two things:

```
envelope (zcms-package.json)     payload (payload.tgz)
├── checksum (SHA-256)           └── theme.json / plugin.json
├── manifest                         dist/index.mjs
├── publisherSignature               dist/theme.css
├── publisherKey                     ...
└── marketplaceSignature (added when the marketplace accepts it)
```

A package is **data, not a program that runs at install time**. No source, no
node_modules, no install scripts. `node_modules`, `.git`, `.env*` and `.DS_Store`
are refused entry at pack time.

Packing is **reproducible**: the same source produces the same checksum (entries
sorted, mtimes zeroed, POSIX separators). That is what lets anyone check that a
package on the marketplace was built from the source they can read.

## Screenshots and video

Nobody installs a theme they cannot see. A package may declare up to three
screenshots and one video, in `theme.json` / `plugin.json`:

```json
{
  "media": {
    "screenshots": [
      "screenshots/home.png",
      "screenshots/post.png",
      "screenshots/dark.webp"
    ],
    "video": "https://www.youtube.com/watch?v=…"
  }
}
```

The images live **inside the signed package**. That is the point: they are
covered by the publisher's signature and the marketplace's counter-signature
exactly as the code is, so a screenshot cannot be swapped for something else
without breaking a signature. A marketplace that kept its pictures in a bucket
beside the code could not say that.

The video is **not** in the package — it is an `https` URL to somewhere that
already does video. A thirty-second clip would eat the whole package budget, and
every install of that package would pay to download a video almost nobody
watches.

The rules, enforced by `@zcmsorg/package` at **pack time** (so the author hears it
from their own terminal) and again by the marketplace at **publish time** (which
does not assume the package it was handed came out of our packer):

| Rule | Limit | Why |
|---|---|---|
| Count | 3 | It is a gallery, not an album — and it is what the admin renders. |
| File size | 2 MB each | 3 × 2 MB fits inside the package budget with room to spare. |
| Dimensions | 4096px per side | Compressed bytes are not pixels. A 300-byte PNG can decode to a billion of them, and the browser opening the lightbox pays for every one. |
| Format | `.png` `.jpg` `.webp` | Raster only. |
| **No SVG** | — | An SVG is not a picture, it is a document, and it can carry `<script>`. Serving a stranger's SVG from the admin's own origin is XSS with extra steps. |
| Path | inside the package | `../../.ssh/id_rsa` is not a screenshot. |
| Video | `https://` URL | `javascript:` is not a video either. |

A declared image that is not in the package is an error, not a shrug — otherwise
the catalogue shows a broken image and nobody knows why. So is a file named
`.png` that is not a PNG: the extension is a claim, and the header is the fact.

The marketplace extracts the images on publish and serves them at
`/api/v1/registry/media/{kind}/{key}/{version}/{index}` — addressed by **index**,
not by filename, because a filename in a URL pointed at a file store is the shape
of every path-traversal bug ever written. Browsing needs this: whoever is looking
has not installed the package yet, and so has nothing to look inside.

## Two signatures, two questions

```
publisher signature   → "who wrote this?"        (the author's private key)
marketplace signature → "do we let it in?"       (Z-SOFT's private key)
```

Both are Ed25519 over the payload's SHA-256 digest — the digest *is* the identity
of the bytes, so signing it signs the content. Ed25519 because the keys and
signatures are small and there are no parameter choices to get wrong.

**A runtime verifies the MARKETPLACE signature**, using a public key **pinned in
its own config** — not a key fetched from the API, and not the key that arrived
inside the package. An attacker who can serve a package can also serve the key
that vouches for it; verification against a travelling key verifies nothing.

This preserves the property the on-disk bundles had: **a compromised cms-api
still cannot make a runtime execute code**, because it does not hold the
marketplace's private key.

> The system's third invariant (after RLS and "plugin-runtime holds no
> credentials"): **a runtime runs only packages signed by a key it pinned.**

## The third question: "is our own code our own code?"

The two signatures above are about *strangers*. For a long time the code with the
most privilege in the system was the code nobody checked at all.

A **built-in** plugin — zAI, SEO — ships inside the image rather than through the
marketplace. plugin-runtime used to simply read `plugins/zai/dist/index.js` off the
volume and run it, on the reasoning that the volume belongs to the operator. Which
is true right up until it isn't: a bad image layer, a mounted host path, a
compromised CI step, an operator with a text editor. And zAI is not a small thing to
own — it holds `network:fetch` and spends the site's API keys.

So there is a third key, and a third question:

```
first-party signature → "is the code we ship the code we signed?"   (the operator's key)
```

A built-in now ships as a signed `.zcms` sitting next to its source
(`plugins/zai/vn.zsoft.plugin.zai-0.3.0.zcms`, committed), and plugin-runtime
verifies it against **`FIRST_PARTY_PUBLIC_KEY`** — pinned in its own config, exactly
as the marketplace key is — before a byte of it executes.

Two consequences worth being explicit about:

- **`dist/index.js` on the volume is no longer read.** Editing it does nothing. The
  code comes out of the verified payload.
- **So does the manifest.** That one is easy to miss and is the more interesting
  hole: a manifest declares a plugin's permissions and `network.hosts`, and the
  gateway enforces the allowlist by reading it back out of the catalogue row. If the
  seed had kept reading the loose `plugin.json`, anyone who could edit that file
  could widen zAI's allowlist to `attacker.example`, have an admin consent to it on
  a screen that faithfully displayed what it was told, and never touch a byte of
  signed code. `seed-plugins` therefore reads the manifest **out of the verified
  package**.

No marketplace is involved, and that is the point: a built-in works offline, in an
air-gapped install, with no registry to call. `verifyFirstParty` exists so it can
still be *checked*.

This applies to **themes as well as plugins**, and for a theme the argument is
stronger rather than weaker. A plugin runs in an isolated-vm isolate, inside a
separate process that holds no credentials. **A theme is not sandboxed at all**: it is
`import()`ed into site-runtime and rendered there, with site-runtime's own Node, its
own `process.env`, its own filesystem. There is no isolate underneath it to catch
anything. For a built-in theme, the signature is the only boundary there is.

All four themes we ship are signed and verified. The default theme is the one that
exists twice — once as a signed package like the others, and once compiled into
site-runtime's bundle — and those two copies are for different jobs. The compiled-in
one is the **fallback**, used when any theme fails to load. It has to be the thing
that cannot fail the same way, which is exactly what "came from our build rather than
from the volume" buys.

```bash
pnpm keygen:first-party   # once. Private half -> .keys/ (gitignored). Public half -> keys/, committed.
pnpm sign:builtins        # after every change to a built-in plugin's or theme's source.
pnpm seed:builtins        # register them in the catalogue, from the SIGNED manifest.
```

Rotating the key means re-signing every built-in **and** updating
`FIRST_PARTY_PUBLIC_KEY` everywhere. A runtime pinned to the old key refuses to run
the new plugins — which is the system working, not breaking.

## The fourth question: "did the operator vouch for this?" — sideloading

The marketplace answers "did the registry approve this stranger's code?"; the
first-party key answers "is the code we ship the code we signed?". Neither helps the
operator who runs a **self-hosted, maybe air-gapped** instance and wants to install a
theme or plugin **they wrote themselves**, without a marketplace in the loop. That is
sideloading, and it has its own trust anchor — a third pinned key, the **operator
key**:

```
operator signature → "did THIS instance's operator vouch for this?"   (the operator's key)
```

Same discipline as the other two: the runtimes pin `OPERATOR_PUBLIC_KEY` and verify a
sideload against it, on a trust route the caller names explicitly — a package handed
the wrong route is refused, never retried against another key. It is off by default;
an instance with no operator key pinned refuses every upload.

**The workflow.** An admin with the owner-only `theme:sideload` / `plugin:sideload`
permission uploads a package under Admin → Appearance (or Plugins) → *Install from
file*. It lands **quarantined**: verified and stored, but no runtime can fetch it
until the same admin clicks **Approve** — the review the marketplace would have done,
performed by the operator, as a durable audited act rather than a dialog. Uninstall
falls any live sites back to safety, purges the runtime caches, and deletes it.

**Two postures, and a boundary you choose to keep or spend.** cms-api holds no
signing key today — which is why a compromised cms-api still cannot make a runtime
run code (it cannot forge a signature). Sideloading lets you keep that or trade it:

| | You do | cms-api holds | Trade-off |
| --- | --- | --- | --- |
| **Offline-sign** (default, safer) | `zcms pack --operator-key op-private.pem …`, upload the `.zcms` | nothing | Compromising cms-api is still **not** code-exec in site-runtime. Needs the CLI. |
| **Server-sign** (convenient) | upload a plain `.zip`; cms-api unpacks, packs and signs it | `OPERATOR_PRIVATE_KEY` | A cms-api compromise **becomes** code-exec in site-runtime. No CLI needed. |

The `.zip` path is the only reason cms-api ever unpacks an archive it did not make,
so it goes through a hardened reader (`packages/package/zip.ts`) that refuses
symlinks, path traversal, decompression bombs and special files, then hands a clean
tree to the same allow-listed packer — no zip byte travels further. Server-sign is
opt-in precisely because holding the key is the thing that spends the boundary.

**Themes are gated twice.** A theme runs unsandboxed in site-runtime, so sideloading
one is code execution in the process that renders every page. It needs the owner
permission **and** `ALLOW_THEME_SIDELOAD=true`, set on purpose. A plugin runs in the
isolate regardless, so it needs only the permission.

**A sideload cannot impersonate.** It may not take an id that belongs to a built-in
or a marketplace package, nor the reserved `vn.zsoft.` namespace, and the runtimes
independently force any key they know as built-in down the first-party path whatever
origin cms-api reports — so a file named `vn.zsoft.theme.default` can never displace
the safe-harbour fallback. Sideloaded packages carry `origin=SIDELOAD`; they never
appear in the marketplace catalogue, and the admin shows them apart, as unverified.

To bake a signed built-in (BUILTIN, not SIDELOAD) into the image instead, see
`pnpm sign:builtins` above — that is a different path, for code Z-SOFT ships.

## The flow

```
1. zcms keygen            the author generates a key pair; the private key NEVER leaves their machine
2. register publisher     POST /publishers, then add the PUBLIC key. A reviewer verifies
                          both identity and key; an unverified publisher/key may publish nothing.
3. zcms pack              package + sign with the author's private key
4. POST /api/v1/packages  upload to marketplace.z-cms.org
   ├── openPackage         open it, execute NOTHING
   ├── re-hash the payload never trust the checksum in the envelope
   ├── verify publisher    against an ACTIVE key in the DB, NOT the key inside the package
   ├── scanPackage         static scan → reject (400) | flag (QUARANTINED) | pass (APPROVED)
   ├── marketplace signs   counter-signs the checksum (only reject stops here)
   └── store + register    stores the COUNTER-SIGNED file, with its review status
5. runtime downloads + loads
   ├── download from cms-api
   ├── verifyPackage       against the PINNED key
   ├── unpackTo            path-traversal proof
   └── import()            React is external → the host's React is shared
```

Step 3's "verify against the key in the DB" is where an impostor is caught. A
package carries its publisher's public key, and verifying against *that* would be
very convenient and completely worthless: an attacker forging the package forges
the key alongside it. The key has to come from an ACTIVE `publisher_keys` row that
belongs to the submitter's publisher. `PENDING`, `RETIRED`, `REVOKED`, and
`COMPROMISED` keys are refused for new submissions.

Step 4's "store the counter-signed file" is a bug we made and fixed. Originally
cms-api stored the uploaded file (publisher signature only) and recorded the
marketplace signature in the database. Runtimes verify the signature *inside the
file*, so they never saw it — every install failed with "package not signed by
the marketplace". Only running it end to end exposed that; code review did not.

A published version is **immutable**: re-uploading the same version with
different bytes is a 400. Silently changing what every site already running that
version executes on its next cache miss is the definition of a supply-chain
attack.

## Verification — attacking the pipeline

```bash
pnpm --filter @zcmsorg/package verify:packages
```

Nine checks, all passing:

| Check | What holds |
| --- | --- |
| Path traversal (`../../`) on unpack | the resolved target must stay inside the destination |
| Absolute path | refused |
| Symlink / hardlink inside a package | refused (it could point anywhere) |
| Package the marketplace never signed | `verifyPackage` requires the signature |
| A correctly signed package | verifies — otherwise the whole scheme is theatre |
| Payload modified after signing | the digest changes, the signature no longer matches |
| Signature from a foreign key | verification uses the *pinned* key, so it fails |
| Decompression bomb | 64MB of zeroes compressing to a few KB is refused; the cap is on the UNPACKED size, because the compressed size tells you nothing |
| Reproducibility | the same source produces the same checksum |

Three further layers verified with real requests: an **unregistered publisher** →
403; an **unverified** publisher → 403; a grant exceeding the plugin's manifest →
400 (at the plugin layer).

## Why a theme carries its own CSS

site-runtime builds Tailwind by scanning **its own** source. A theme installed
*after* that build is invisible to it — the theme's classes simply do not exist
in the stylesheet. So a theme compiles its CSS at pack time and carries it inside
the package; the runtime serves it from the verified cache directory
(`/theme-assets/...`).

> That route is deliberately **not** under `_theme`: a directory starting with
> `_` is an App Router *private folder* and is excluded from routing. That bug
> gave us a 404 on the CSS while the theme itself loaded fine — correct markup,
> no styles, nothing in the logs. Another one only an end-to-end run finds.

## React must be shared

A theme bundle declares `react` and `react/jsx-runtime` as **external**, resolved
from the host's node_modules. Two copies of React in one render is the classic way
for a plugin system to produce "invalid hook call" in production only.

## The second theme was not just a demo

Writing the Aurora theme **found a real hole in the Theme SDK contract**:
`BlockComponent<P>` was missing the settings type parameter, so a block could not
be typed against its own theme's settings while a template could — the same
`ctx`, two different shapes depending on where you stood. With only one theme in
front of you, there is no way to see which generic was forgotten. **The only way
to find out whether a contract leaks is to implement it a second time.**

## The CLI

`zcms` (`packages/cli`, published as `@zcmsorg/cli`) has a handful of commands, and
the split is deliberate. Run `zcms help` (or `zcms` with no argument) for the same
list, including worked examples:

```
zcms init [<dir>] [--kind theme|plugin] [--id <reverse.dns.id>] [--yes]
    Scaffolds a theme or plugin: manifest, source, build, test, README. Asks for
    anything it was not given; --yes never asks, for CI. It refuses to write into
    a directory that already holds anything.

zcms keygen [--out <dir>]
    Generates the publisher's Ed25519 key pair. The private key is written 0600
    and must never be committed or shared.

zcms pack <dir> --kind theme|plugin --key <private.pem> --pub <public.pem> [--out <file>]
    Turns a built directory into one signed .zcms file. The result carries a
    publisher signature only, so no runtime will run it yet.
    Add --operator-key <private.pem> to ALSO stamp an operator signature, for
    sideloading into your own instance (see "Sideloading" below).

zcms verify <file.zcms> [--marketplace-key <public.pem>]
    Checks a package the way a runtime would, so an author can prove to
    themselves that what they are about to publish is what they think it is.
    Without --marketplace-key it checks the publisher signature only — enough to
    self-check before submitting, not enough to install.

zcms help
    Prints the command list and the example workflows.
```

### Creating a `.zcms`, step by step

The file you upload — to the marketplace, or into your own instance — is always
produced the same way. From a theme called `com.acme.theme.blog`:

```bash
# 1. Scaffold (skip if you already have a project). This writes a manifest and a
#    build that already satisfy the ESM/.mjs/external-React contracts above.
npx @zcmsorg/cli init ./blog --kind theme --id com.acme.theme.blog

# 2. Build the distributable. The runtime loads dist/, never src/, and never runs
#    your build — so the package must contain a BUILT bundle.
cd blog && npm install && npm run build      # produces dist/index.mjs (+ theme.css)

# 3. Generate your signing key ONCE, and keep the private half safe. keygen writes
#    it 0600 into the project; the packer refuses to include key material, so it
#    never travels inside the package.
npx @zcmsorg/cli keygen                       # -> keys/publisher-private.pem, keys/publisher-public.pem

# 4. Pack + sign. One file comes out, named <id>-<version>.zcms.
npx @zcmsorg/cli pack ./blog --kind theme \
  --key keys/publisher-private.pem --pub keys/publisher-public.pem
# -> com.acme.theme.blog-1.0.0.zcms

# 5. Check your own work the way a runtime will, before anyone else does.
npx @zcmsorg/cli verify com.acme.theme.blog-1.0.0.zcms
```

What ends up inside is only the distributable: the manifest, `dist/`, declared
assets and screenshots. Source, `node_modules`, `.env` and anything matching a key
pattern are dropped by the packer — silently and unconditionally, so a mistake in
your working tree cannot become a leak in the package (`packages/package/archive.ts`,
the `DENIED` list). Plugins are the same recipe with `--kind plugin` and a
`plugin.json`; a plugin's entry is one **CommonJS** file, a theme's is **ESM `.mjs`**
(see "Why `init` exists").

Where the file goes next is the only fork: submit it to the marketplace for review
and counter-signing, or sideload it into an instance you run — next section.

The tool is installed globally (`npm i -g @zcmsorg/cli`), on the machine that holds
the private key behind everything its owner publishes. Its dependency tree is
therefore part of its threat model, not an implementation detail, so the published
artefact has **no dependencies at all**: the signing code and `tar-stream` are
bundled into the one file. That also means the signing implementation an author
runs is the one this repository builds, rather than whatever the registry resolved
for them on the day they installed it.

### Why `init` exists

Not to save typing. Two of this platform's contracts are enforced at *runtime, on
somebody's live site*, and are written down nowhere an author would look — so an
author who guesses wrong finds out from a support ticket:

| | Contract | How it fails when you get it wrong |
| --- | --- | --- |
| **Plugin** | One **CommonJS** file. The sandbox is a V8 isolate that provides exactly one module, `@zcmsorg/plugin-sdk`. | There is no module resolver in there. A plugin compiled across two source files emits a relative `require()`, which the sandbox refuses — at *activation* time, on a site, long after the author's tests passed. |
| **Theme** | Entry is **ESM**, and the file is **`.mjs`**. React is **external**. | A `dist/index.js` takes its module format from the nearest `package.json` `"type"` — and package.json ships inside the payload. Guess wrong and site-runtime throws "Cannot use import statement outside a module", catches it, and silently falls back to the default theme. Bundle a second copy of React and you get "invalid hook call" in production and nowhere else. |

`zcms init` writes a package that already satisfies both, so they stop being
folklore and become the default. The scaffold builds, typechecks, tests, packs,
signs and passes the scanner with nothing changed.

### The private key never travels

`keygen` writes `publisher-private.pem` into the project directory, because that is
where an author runs it — and then `pack` is pointed at that same directory. So the
packer excludes key material (`*.pem`, `*.key`, `*.p12`, `.npmrc`, `id_*`…)
unconditionally and silently, and the scaffold's `.gitignore` covers it too.

This is not defence against a stray file. Without that rule the key that signs the
package ships *inside* it: uploaded to the marketplace, then unpacked onto every
runtime that installs it, signed by the very key it is leaking. A publisher's
identity would be forfeit the first time they published anything. The safe outcome
must not depend on the author having read a warning, so nothing here warns — it
just never packs the key.

`zcms publish` is still **not** there — but the reason has changed. It used to be
that there was nobody to publish *as*: no developer accounts, no self-service
publishers, so the CLI would have had to ask for an admin session it had no way to
get. That is fixed. Developers now sign in to the portal with Google or GitHub,
register a publisher, and upload the `.zcms` there; the whole flow is described in
the marketplace repo. A `publish` subcommand is now merely missing, rather than
incoherent, and it is a small thing: an API token for the developer session, and a
multipart POST to `/api/v1/developer/submissions`.

## The human in the loop

Every package is read by a person before it is servable. Not the flagged ones —
**every** one, including the packages the scanner was perfectly happy with.

That is the part worth being explicit about, because the obvious design is the
other one, and the obvious design is wrong. A scanner is a pattern matcher. It
catches the obfuscated `eval`, the `fetch` to a bare IP, the child process — the
things a careless developer does by accident and a lazy attacker does on purpose.
It is blind to the plausible, well-written backdoor, which is precisely what an
attacker who has read our rules (they are open source; `packages/scanner`) will
write. Publishing on a clean scan would mean the packages most worth catching are
the ones that sail through.

So a clean scan is not an approval. It is the absence of an objection, and those
are different sentences. What the scanner's verdict decides is not *whether* a
human looks, but what they are told before they do:

- **reject** — the upload returns 400 and never becomes a version at all. Nothing
  is stored, nothing is queued, and there is nothing for a reviewer to read.
- **flag** — `QUARANTINED`. It is in the queue with the findings attached, in red.
- **pass** — `PENDING`. It is in the queue anyway, marked "scan clean".

The one exception is a **trusted** publisher, which is first-party code and skips
the queue. `trusted` is set in the seed and is not reachable from the developer
portal — signing up cannot get you it.

That queue is a screen — **`/review`** — but it lives in the private operator
service (`marketplace.z-cms.org`), not in this open-source admin. Review,
publishing, and counter-signing all moved there when the marketplace was split
out; the sections below describe that operator side even though its code is no
longer in this tree. What remains here is the shop a site owner installs from —
see "One marketplace, many instances".

The screen is built around one claim — *a reviewer who cannot see why the scanner
flagged something has not reviewed it.* So the findings are the card, not a link
on the card: rule, `file:line`, message and excerpt, sorted worst-first, never
behind a disclosure. Approving over a blocking finding is possible and says so in
the dialog.

It also shows **who submitted it**. The same `warn` finding means different things
coming from a publisher with a track record and from one that registered this
morning, and a queue that hides the author asks the reviewer to judge the code in
a vacuum. (Packages that predate publishers — the seeded built-ins — render as
"Unknown publisher" rather than pretending to an identity they never had.)

**`/publishers`** is the other half of that: registering a publisher, adding a
new public key, retiring an old one, and — for a reviewer — verifying both the
publisher and the key. Verification is the human step the whole signature scheme
rests on, so `verified` is a **required boolean**, not an optional toggle. Key
state is explicit too: `PENDING` waits for review, `ACTIVE` may sign new uploads,
`RETIRED` remains valid history but cannot sign new uploads, `REVOKED` was removed
or rejected, and `COMPROMISED` means reviewers should inspect packages signed by
that key. Retiring a key does **not** revoke packages already counter-signed by
the marketplace; package revocation is the separate kill switch below.

## One marketplace, many instances

The classic plugin-directory shape, made explicit: `marketplace.z-cms.org` is
where the community publishes and Z-SOFT reviews, and every site built on z-cms.org — plus
every self-hosted install — reads that same catalogue from its own admin and
installs with a click. There are two faces, and **they now live in two
repositories**:

```
REGISTRY face  (/registry/*, PUBLIC)     CLIENT face  (/marketplace/*, session)
private operator service — this repo, the consumer
z-cms-marketplace repo
├── GET /registry/packages               ├── GET  /marketplace/browse   remote catalogue, annotated
├── GET /registry/bundle/:k/:key/:ver    ├── GET  /marketplace/status   where I shop, how fresh my feed is
└── GET /registry/revocations (signed)   ├── POST /marketplace/install/theme/:key/:ver
                                          └── POST /marketplace/install/plugin/:key/:ver
```

**Why they are split.** The operator service holds the private signing key and
faces the whole community, so running it as a slim deployment with no tenant admin
and no plugin execution shrinks the attack surface of the thing that matters most;
and the curation/moderation logic is Z-SOFT's to keep private. This is a
product/operations decision. It buys **no** security through obscurity: the trust
boundary is the pinned key, and nothing in the consumer relies on the registry
code being secret. A consequence of Option B is that a self-hoster is a consumer
only — it points `MARKETPLACE_URL` at Z-SOFT's registry (or another compatible
one) and cannot serve its own catalogue from this open-source tree.

Three properties are load-bearing:

- **The registry is public.** Browsing without an account is the whole point of a
  marketplace, and the bundles defend themselves — each carries the marketplace's
  counter-signature, so serving one to a stranger gives away nothing the signature
  does not already protect.
- **Install names a package, never a URL.** `POST /marketplace/install/plugin/acme/1.2.0`
  — the host it is fetched from comes from the instance's own `MARKETPLACE_URL`,
  not the request. If a tenant could name the download host, "install a plugin"
  would become a request-forgery primitive aimed at whatever the API server can
  reach, which on most clouds includes the metadata service.
- **Downloading is not installing-on-a-site.** `install` pulls the verified bytes
  into the catalogue and grants nothing. Putting a plugin ON a site — with the
  permission-consent screen — is still `POST /plugins/:key/install`. The scary
  grant happens where the admin can read what they are agreeing to.

What lands in the database is verified against the **pinned key** before it is
written (`installVerified`), so a marketplace that has been taken over — or a
hostile look-alike an instance was pointed at — cannot make the instance hold, let
alone run, a package it did not sign. Verified end to end: this instance browsed
its own registry, installed Aurora, and the downloaded bundle verified against the
pinned key and refused a foreign one.

This admin has one screen for this: **`/marketplace`**, the shop a site owner
installs from. Browsing is gated on `theme:read` (harmless); each install button
on its own `*:install` scope. The operator's counterpart — `/review`, where code
is let in and pulled back out — lives in the private operator service, not here.

## The kill switch reaches across instances

On the operator service, rejecting or revoking a version pulls it there. Neither
does a thing about the thousand other instances that installed the package last
month — they hold the bundle on disk and the module in memory and keep serving it.
That is the hole every delisting-only directory has: a plugin closed for a
critical vulnerability is delisted, and the sites that already have it run it,
silently, forever.

The only channel that reaches an installed package is the update check — so the
kill switch is modelled on the update check. The marketplace publishes a **signed
revocation list** at `GET /registry/revocations`; every consumer instance pulls it
hourly (`marketplace.sync`, a worker cron), verifies it against its **pinned key**,
and enforces each entry through `applyRevocation` — theme → built-in default,
plugin → QUARANTINED, runtime caches purged.

An unsigned revocation list would be catastrophic: a remote uninstall button for
anyone who can answer a DNS query. So the list is Ed25519-signed over a canonical
digest, and the consumer **recomputes that digest** rather than trusting the one
on the wire — the same rule the package pipeline follows for the payload checksum.
Removing an entry (to keep your own malicious plugin alive) breaks the signature;
so does appending one (to disable a competitor). A genuinely-signed but **stale**
list — captured before your package was pulled and replayed — is refused as a
rollback, because an instance keeps the newest `issuedAt` it has accepted and will
not go backwards.

```bash
pnpm --filter @zcmsorg/package verify:revocations   # 8 checks, all passing
```

Verified live, not just in the unit suite: a marketplace revoked a theme and a
plugin that were **active on a running site**; the sync moved the site to the
default theme, quarantined the plugin, and **the site stayed HTTP 200 throughout**.
A replayed month-old list was refused as a rollback and raised a
`marketplace.revocation_rejected` alert, and the revoked package did **not** come
back.

**Sync is fail-open, and that is a decision.** An instance that cannot reach the
marketplace keeps running what it has — because a marketplace outage must not dark
a thousand customer sites. The residual risk is stated plainly rather than hidden:
an attacker who can hold an instance off the network can *delay* a revocation. So
staleness is surfaced. The `/marketplace` screen shows how old the feed is, and
goes amber past a day — the difference between "nothing to revoke" and "I have not
been able to ask in six weeks," which from the inside look identical. The usual
fail-open design makes the same call and shows the user none of it.

## What we still owe before opening this to the community

- **No dependency vulnerability scanning.** The static scanner reads the code in
  the package; it does not know that a version of a library the package bundles
  was disclosed last week.
- **plugin-runtime egress is not restricted** at the infrastructure layer.
- **`zcms publish` does not exist** — developers submit through the portal
  (sign in with Google or GitHub, register a publisher, upload the `.zcms`). The
  CLI could do it now that developer sessions exist; it does not yet.
- **The revocation feed is a full snapshot, not a delta**, and unpaginated. Fine
  for hundreds of revocations; revisit before it is tens of thousands.

## The kill switch

> **Which side you are reading.** *Pulling* a package (the revoke endpoint and the
> operator's revoke button, below) lives in the private operator service, like review
> and publishing. What runs in **this** repo is the receiving end: every hour, the
> `marketplace.sync` job fetches the signed revocation list, `verifyRevocationList`
> checks its signature and refuses a rewound one, and `applyRevocation` quarantines
> anything on it. The sections below describe both ends, because a kill switch you only
> understand half of is one you will not trust in the hour you need it.

`review(reject)` closes the door to NEW installs. It does nothing about the copies
already out there: a runtime that has the bundle on disk and the module in memory
keeps serving it until it restarts, which for a long-lived server can be weeks.
That is not a kill switch; it is a note.

```
POST /api/v1/packages/revoke/:kind/:key/:version   { "reason": "..." }   ← operator service
```

Does three things, and needs all three:

1. marks the version REJECTED — the bundle endpoint refuses it;
2. moves every affected site off it. A theme falls back to the **built-in
   default** (compiled into site-runtime, and therefore the one thing that cannot
   itself be revoked); a plugin is set QUARANTINED, not INACTIVE, so an admin
   cannot simply click "activate" again on code the marketplace pulled;
3. calls the runtimes' purge endpoints, which drop the in-memory module and delete
   the verified cache directory.

Pulling bad code must not take the customer's site down with it. Verified: a site
running a revoked theme stayed **HTTP 200** throughout and rendered the default.

> Trusting the API for the purge is safe, and worth being explicit about: it can
> only ever *remove* trust. Making a runtime *load* something still requires a
> marketplace signature the API does not hold the key for.

It alerts, because pulling live code is an incident by definition. A purge that
fails to reach a runtime is logged at error level — that runtime may still be
executing the revoked package, and the difference between a kill switch and a note
is exactly that message getting through.

### Revoking, from the admin

The published-versions table carries one number the revoke button cannot do
without: **`sitesUsing`** — how many live sites are executing this code right
now. A revoke button that does not tell you that is asking an operator to guess
at the blast radius of an irreversible action, so the confirm dialog leads with
it, spells out what happens (a theme falls back to the built-in default; a plugin
is quarantined; the runtimes' caches are purged so it stops executing), and
**requires a reason** — the API 400s without one, and the button stays disabled
until there is one.

**A revoked version stays revoked.** There is no un-revoke, deliberately: if a
package was pulled and later cleared, publish a new version. An un-revoke would
mean the kill switch could be un-pulled by whoever pulled it, which makes it a
note again. (Aurora is the worked example: `1.0.1` and `1.0.2` are revoked
forever, and the fix shipped as `1.1.0`.)

## Not done yet

- **No `zcms publish`.** The CLI does `keygen`, `pack` and `verify`; developers
  upload through the marketplace's developer portal rather than from a terminal.
- **No update-all / bulk install.** A site owner installs one package at a time;
  there is no "update everything with a newer version" action yet.
- **The registry catalogue is unpaginated** (`take: 60`). A `log()`-worthy cap to
  lift before the marketplace holds more than a page of packages.
