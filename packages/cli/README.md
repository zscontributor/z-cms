# zcms

The command-line tool for building and publishing [Z-CMS](https://z-cms.org) themes and plugins.

```sh
npm install -g @zcmsorg/cli
```

It has no dependencies. The signing code is bundled in, so the bytes that sign
your packages are the ones this repository builds — not whatever the registry
resolved on the day you installed it. That matters more than it usually would:
this tool lives on the machine that holds the private key behind everything you
publish.

## Start a package

```sh
zcms init
```

It asks what you are building, and writes a theme or a plugin that already
builds, already typechecks, already has a test, and — the part that is easy to
get wrong — already satisfies the two contracts the platform enforces at runtime
rather than at build time:

- **A plugin is one CommonJS file.** It runs in a V8 isolate that provides exactly
  one module, `@zcmsorg/plugin-sdk`. There is no module resolver in there, so a
  plugin compiled across two source files emits a relative `require()` that fails
  when an admin activates it — on a live site, long after your tests passed. The
  scaffold bundles to a single file, so you can split your source however you like.
- **A theme entry is ESM, and shares the host's React.** The runtime imports it by
  `file://` URL, and React is external so your components run on the same React
  instance as the site. Bundle a second copy of React and you get "invalid hook
  call" in production and nowhere else.

Non-interactive, for scripts and CI:

```sh
zcms init ./hello --yes --kind plugin --id com.acme.plugin.hello --author "Acme"
```

`init` will not write into a directory that already holds anything.

## Publish a package

```sh
zcms keygen                  # once, ever
zcms pack . --kind plugin --key publisher-private.pem --pub publisher-public.pem
zcms verify com.acme.plugin.hello-0.1.0.zcms
```

`keygen` writes an Ed25519 key pair. The private half never leaves your machine
and is written `0600`; the public half is what you register with the marketplace
to become a publisher. `keygen` refuses to overwrite an existing private key,
because overwriting one orphans every package it has ever signed.

`pack` produces a single `.zcms` file: a manifest, a checksum, your signature,
and a tarball of the built package. No source, no `node_modules`, no install
scripts — a package is data, not a program that runs when it lands.

`verify` checks it the way a runtime would. Note what it does **not** say: a
package you just packed carries your signature only, and a runtime will refuse to
run it. Only the marketplace's counter-signature, added after review, makes a
package installable. Pass `--marketplace-key` to check that too.

## Commands

| Command | What it does |
| --- | --- |
| `zcms init [dir]` | Scaffolds a theme or plugin. Asks for what it was not given; `--yes` never asks. |
| `zcms keygen [--out dir]` | Generates your publisher key pair. |
| `zcms pack <dir> --kind theme\|plugin --key <pem> --pub <pem>` | Packs a built directory into one signed `.zcms`. |
| `zcms verify <file.zcms> [--marketplace-key <pem>]` | Checks a package's signatures. |

There is no `publish`. Submitting a package is an authenticated upload to the
marketplace, and a `zcms publish` that could not actually do it would be a lie in
tab-completion form. It arrives with the publisher account system.

## Documentation

- [Writing a plugin](https://github.com/zscontributor/z-cms/blob/main/docs/plugins.md)
- [Packaging and distribution](https://github.com/zscontributor/z-cms/blob/main/docs/distribution.md)

MIT © Z-SOFT Co., Ltd.
