# @zcmsorg/i18n

The core message catalogue of Z-CMS: the admin UI, the API's error messages, and
the public runtime's own pages.

**English is the base locale.** Every other language falls back to it *key by key*,
so a language that covers 40% of the catalogue shows 40% in your language and the
rest in English — never a blank screen, never a crash.

That is not a detail; it is the reason you can contribute a translation without
finishing it. **A partial translation is worth merging**, and you are not signing
up for a marathon.

> Themes are **not** translated here. A theme carries its own messages, in its own
> package — see [docs/i18n.md](../../docs/i18n.md#translating-a-theme).

---

## Adding a language, step by step

Say you are adding Japanese (`ja`). You will touch **two things, and neither of
them is TypeScript.**

### 1. Create the folder and translate

```bash
cp -r packages/i18n/src/locales/en packages/i18n/src/locales/ja
```

Translate the **values**. Leave the **keys** exactly as they are — they are
identifiers, not text:

```json
{
  "media": {
    "tooLarge": "The file is larger than the {limit} limit."
  }
}
```

Two rules, and the checker enforces both:

- **`{braces}` are values the code fills in at runtime.** They must survive into
  your translation, spelled identically. Word order is yours to change; the
  placeholder name is not.
- **Do not invent keys.** A key that does not exist in English is an error, not a
  bonus.

**You do not have to copy all ten files.** Translate `common.json`, delete the
rest, and open the PR — a namespace you do not ship is served from English, the
same way an individual key is. There is no such thing as a file you must create
and leave empty.

### 2. Register it — one line in `locales.json`

```json
[
  { "code": "en", "name": "English",    "nativeName": "English",    "dir": "ltr" },
  { "code": "vi", "name": "Vietnamese", "nativeName": "Tiếng Việt", "dir": "ltr" },
  { "code": "ja", "name": "Japanese",   "nativeName": "日本語",      "dir": "ltr" }
]
```

| Field | |
| --- | --- |
| `code` | The BCP-47 tag. It **must** match the folder name byte for byte. See below. |
| `name` | English name. Contributor-facing tooling only. |
| `nativeName` | The name as its own speakers write it — **the only one a user ever sees** |
| `dir` | `ltr` or `rtl`. It is applied to `<html dir>`, so get it right. |
| `flag` | Optional. Almost always leave it out — see below. |

The order of the array is the order the language switcher shows them in.

#### The flag

You do not normally write one. The flag is derived from the `code`: `ja` gets
Japan, `pt-BR` gets Brazil, `ca` gets Catalonia. Add the language, get the flag.

Write `flag` only to overrule that, and there are exactly two reasons to:

```json
{ "code": "en", "name": "English", "nativeName": "English", "dir": "ltr", "flag": "us" }
{ "code": "ar", "name": "Arabic",  "nativeName": "العربية",  "dir": "rtl", "flag": null }
```

The value is an **ISO 3166-1 alpha-2 country code, lowercase** — the country, not
the language. `vn`, not `vi`. A code `flag-icons` does not ship fails `check`,
so a typo cannot reach a user as a broken image.

`null` means *no flag*, and it is a legitimate answer rather than a gap. Some
languages already resolve to it on their own: Arabic is spoken across twenty
countries and Esperanto across none, and picking one flag for either says
something untrue about whose language it is. Those render with the name alone,
which is fine — **the flag is never what names the row.** Every switcher shows it
beside the native name and reads correctly without it. That is the property that
makes flags safe to have here at all, and it is why you should not reach for
`flag` just because a language's row looks emptier than its neighbours'.

#### Picking the right `code`

**Look it up — do not guess.** The code is how the browser's `Accept-Language`
finds your translation; a plausible-looking wrong code means the language is
never served to anyone, and nothing anywhere reports an error.

- 🔎 **[Language Subtag Lookup](https://r12a.github.io/app-subtags/)** — the W3C
  i18n tool. Type "Japanese", get `ja`. **Start here.**
- 📖 [IANA Language Subtag Registry](https://www.iana.org/assignments/language-subtag-registry/language-subtag-registry)
  — the authoritative list the tool above searches.
- 📄 [BCP 47](https://www.rfc-editor.org/rfc/rfc5646) — the spec itself, if you
  want the grammar.

**Use the shortest tag that is still correct.** A language is `ja`, `vi`, `de` —
not `ja-JP`, `vi-VN`, `de-DE`. Add a subtag only when the text genuinely differs:

| | |
| --- | --- |
| `pt-BR` / `pt-PT` | Brazilian and European Portuguese really are different translations |
| `zh-Hans` / `zh-Hant` | Simplified vs Traditional Chinese — a **script**, not a country. `zh-CN` is the common mistake. |
| `vi-VN` | Wrong. There is no other Vietnamese. Use `vi`. |

A regional tag falls back to its base language anyway: a `pt-PT` browser is
served `pt-BR` if that is the only Portuguese on offer, and `zh-Hant-TW` is served
`zh-Hant`. So splitting a language you do not need to split only doubles the work.

**Casing is part of the standard, not a preference:** language lowercase, script
Title-case, region UPPERCASE — `pt-BR`, `zh-Hant`, `sr-Latn`. `sync` rejects
anything else, including a folder that matches its code only case-insensitively:
that one resolves on a Mac and disappears on Linux CI.

### 3. Regenerate and check

```bash
pnpm --filter @zcmsorg/i18n sync     # rewrites src/locales.ts and src/catalog.ts
pnpm --filter @zcmsorg/i18n check    # exactly what CI runs
```

`sync` writes two **generated** files. Commit them; never hand-edit them.

`check` prints how complete your language is, and **fails** on the mistakes that
otherwise reach production silently:

| | |
| --- | --- |
| A key missing from your language | **warning** — the fallback is doing its job, and the language may still be `experimental` (see below) |
| A key that does not exist in English | **error** — a stale key, or a typo in yours |
| A value that is not a string | **error** |
| A `{placeholder}` dropped, renamed or invented | **error** |
| A `code` that is not a well-formed BCP-47 tag (`pt_BR`, `PT-br`) | **error** |
| `locales.json` and the folders disagree, either direction | **error** |
| A `flag` that `flag-icons` does not ship (`vm` for Vietnam) | **error** |
| A `flag` that is the **language** code (`"flag": "vi"`) | **error** — and this one is why you should just omit the field: `vi` is a real flag, the US Virgin Islands. Nothing but this check stands between that typo and every Vietnamese reader seeing the wrong country. |
| A folder that matches its code only case-insensitively | **error** |
| `sync` not run — the generated files are stale | **error** |

That last pair is the difference between a language that works and a language that
is *translated on disk and invisible at runtime*. It used to be possible to ship
the second one. It no longer is.

### 4. Open the pull request

Say roughly how complete it is. Nobody expects 100%.

---

## When does a language appear in the switcher?

**Merging and offering are two different gates.** A translation at 20% is merged —
the fallback makes it harmless, and you get to stop and come back later. But the
language switcher is a *promise*: a user who picks their own language and lands on
a mostly-English screen concludes the feature is broken, not that the translation
is young.

So a locale is `experimental` until it covers **95% of the required namespaces**:

| Required | keys | |
| --- | ---: | --- |
| `common` | 28 | buttons, dialogs |
| `auth` | 52 | the login screen |
| `admin` | 297 | navigation, dashboard, settings, users, jobs |
| `content` | 159 | the content editor — the thing a CMS is *for* |
| | **536** | **of 917 — about 58%** |

`plugins`, `errors`, `media`, `mail`, `appearance` and `site` are not required. They
fall back to English, key by key, and the language still ships.

### Why not simply "50% of all keys"

Because the keys are not evenly distributed, and a flat percentage gates on the
wrong thing: *how many* keys, when what matters is *which*. Measured against
today's catalogue:

| What the translator did | all keys | required | switcher |
| --- | ---: | ---: | --- |
| the three biggest namespaces (`admin`, `plugins`, `errors`) | **57%** | 55% | **hidden** |
| the visible chrome only (`common`, `auth`, `admin`) | 41% | 70% | **hidden** |
| exactly the required set | 58% | **100%** | **offered** |

Under a flat 50% rule the first row **passes** — 57% of the catalogue translated,
and the login screen and the content editor still in English. Ours refuses it, and
offers the third. The gate has to read which keys are translated, not how many.

### Why 95% and not 100%

Because 100% would let an unrelated pull request delete a language. Add five
English keys to `content`, and every locale on earth drops below 100% and vanishes
from the switcher on the next deploy — punishing translators for a change they did
not make, in a build nobody thought was about i18n.

95% of 536 keys leaves 26 keys of slack: enough to absorb the base locale growing,
not enough to skip a namespace (dropping `auth` entirely costs 52 keys and lands at
90%).

### Reading it

`check` tells you where you stand and what is left:

```
th: 58% (536/917 keys) — OFFERED
  381 key(s) fall back to en.
  100% of the required namespaces (common, auth, admin, content) — 536/536 keys.

id: 36% (330/917 keys) — EXPERIMENTAL
  587 key(s) fall back to en.
  55% of the required namespaces (common, auth, admin, content) — 297/536 keys.
  Not yet in the language switcher. 213 more required key(s) (95%) and it is offered to users.
```

(Both are made up. The three locales that actually ship — `en`, `vi`, `ja` — are all
at 100%.)

An experimental locale still **works**: it resolves, `<html dir>` is set for it,
and anyone who sets the cookie explicitly gets it. It is simply not advertised
yet. In code: `LOCALES` is every locale, `SWITCHER_LOCALES` is the offered ones.

---

## Using it in code

### Two entrypoints, and the difference matters

| | Exports | Import it from |
| --- | --- | --- |
| `@zcmsorg/i18n` | translator, locale metadata, **and the catalogue** | cms-api, server components |
| `@zcmsorg/i18n/client` | translator, locale metadata | anything with `"use client"` |

`@zcmsorg/i18n/client` **does not export the catalogue**, and that omission is the
feature.

`import { catalog } from "@zcmsorg/i18n"` inside a client component compiles, works,
and quietly ships **every language the project has ever merged** to a user who
reads one of them. Nothing breaks — the admin just gets heavier with every
translation PR, so the project is punished, in page weight, for succeeding at i18n.
Being an easy mistake to make and impossible to notice, it is not left to code
review: from `/client`, that import does not resolve.

### On the server

```ts
import { t, messagesFor, LOCALES } from "@zcmsorg/i18n";

t("vi")("common.save");                         // "Lưu"
t("vi")("errors.media.tooLarge", { limit: "20 MB" });

messagesFor("vi");   // one locale, English fallback already folded in
```

cms-api does not call `t(locale)` directly — it negotiates the locale from
`Accept-Language` in middleware and exposes a request-scoped `t()`:

```ts
import { t } from "../common/i18n";
throw new NotFoundException(t()("errors.content.notFound"));
```

### On the client

The server resolves the user's locale and passes the messages down; client
components read them through the hook and never see a catalogue:

```tsx
// app/layout.tsx — a server component
const messages = messagesFor(locale);
return <LocaleProvider locale={locale} messages={messages}>{children}</LocaleProvider>;
```

```tsx
"use client";
import { useT } from "@/lib/i18n-provider";

const t = useT();
<button>{t("common.save")}</button>
```

The messages ride in the RSC payload with the first HTML: **no network round trip,
no flash of untranslated UI**, and a payload whose size depends on how much text
the admin contains — not on how many languages exist.

---

## Layout

```
locales.json              the registry. One line per language. You edit this.
src/locales/<code>/*.json the messages. You edit these.
src/flags.ts              code -> flag. A hand-written table; read the note at the top.
src/locales.ts            GENERATED — codes, native names, direction, flag. No JSON imports.
src/catalog.ts            GENERATED — every message, every locale. Server-side only.
src/client.ts             the browser-safe entrypoint (no catalogue)
src/index.ts              the server entrypoint
src/translator.ts         lookup, fallback, {placeholder} interpolation, Accept-Language
src/types.ts              the public types
scripts/coverage.ts           which namespaces are required, and the 95% gate
scripts/generate-catalog.ts   `sync` / `check --check`
scripts/check-locales.ts      key drift, types, placeholders
scripts/sync-flags.ts         copies the flag SVGs into each app's public/ at build time
scripts/flags-source.ts       where those SVGs come from
```

`LOCALES` is every locale in the build; `SWITCHER_LOCALES` is the subset the admin
offers. Both live in `locales.ts`, so a client component can read them without
pulling in a single message.

**Why two generated files instead of one?** `locales.ts` is metadata and imports no
JSON, so a browser bundle can safely import it for the language switcher.
`catalog.ts` is the messages. Keeping them apart is what lets `/client` exist.

**Why generate them at all?** They only encode *structure* — which locales exist,
which namespaces each one actually ships — and structure is what a script derives
from the filesystem without a human forgetting a line. The hand-written version
cost ten `import` statements per language in one shared file, so two contributors
translating two unrelated languages collided in the same hunk. Appending a line to
a JSON array is a conflict git resolves on its own.

---

## Commands

| | |
| --- | --- |
| `pnpm --filter @zcmsorg/i18n sync` | Regenerate `src/locales.ts` and `src/catalog.ts` |
| `pnpm --filter @zcmsorg/i18n check` | Key drift, placeholders, registry/folder agreement, staleness |
| `pnpm --filter @zcmsorg/i18n build` | Sync the flags, then `tsc` → `dist/` |
| `pnpm --filter @zcmsorg/i18n flags:sync` | Re-copy the flag SVGs into the apps on their own |
| `pnpm --filter @zcmsorg/i18n test` | `check`, then the unit suite |

## Style

- Translate the **meaning**, not the words. If the English is clumsy in your
  language, write the sentence a native speaker would write.
- Z-CMS speaks plainly to an administrator: no exclamation marks, no apologising.
- Do not translate identifiers or product names inside a message (`X-Site-Id`,
  `PUBLISHED`, `Z-CMS`).
- If a key's English is genuinely ambiguous, that is a bug in the English. Open an
  issue rather than guessing — you will not be the last person to hit it.

Not everything belongs in a catalogue: log lines, `console.warn` diagnostics and
CLI output stay in English. An engineer reading a stack trace at 3am is not helped
by one line of it in a language the rest is not in. The full reasoning, and how to
translate a **theme**, is in [docs/i18n.md](../../docs/i18n.md).

## License

MIT © Z-SOFT Co., Ltd.
