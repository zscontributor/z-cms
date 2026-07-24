# @zcmsorg/theme-sdk

The contract for writing a [Z-CMS](https://z-cms.org) theme: templates, blocks, settings, SEO and translations.

A theme reaches the platform through exactly one module — this one. No database, no API client, no Next.js. That is what makes a theme a *package* — something a site installs — rather than something you deploy.

## Install

You normally do not install this by hand — scaffold a theme instead, and it comes wired up:

```sh
npm i -g @zcmsorg/cli
zcms init my-theme --kind theme
```

To add it to an existing package:

```sh
npm i @zcmsorg/theme-sdk react
```

React 19 is a peer dependency.

## Usage

The manifest lives in `theme.json` — the same file the packer signs — and the settings form the admin renders is generated from its `settingsSchema`. A colour hardcoded in a template is a colour the site owner can never change.

```tsx
import {
  defineTheme,
  type LayoutProps,
  type PageTemplateProps,
  type ThemeManifest,
} from "@zcmsorg/theme-sdk";
import manifestJson from "../theme.json";

const manifest = manifestJson as unknown as ThemeManifest;

interface Settings {
  accent: string;
  siteTitle: string;
}

function Layout({ ctx, children }: LayoutProps<Settings>) {
  return (
    <div style={{ ["--accent" as string]: ctx.settings.accent }}>
      <header>{ctx.settings.siteTitle}</header>
      {children}
    </div>
  );
}

function Page({ ctx }: PageTemplateProps<Settings>) {
  return <article>{ctx.content.title}</article>;
}

export default defineTheme<Settings>({
  manifest,
  Layout,
  templates: { page: Page },
});
```

Everything a template can see arrives as `ctx`; everything an owner can change arrives as `ctx.settings`.

## Dark and light mode

A theme is a **server component** and ships no client JavaScript — that is the deal that lets a Z-CMS site install a stranger's theme without also running their code in the visitor's browser. It is also why a theme cannot implement dark mode by itself: the switch needs a click handler, the choice has to outlive the page, and it must be applied before first paint or the reader gets a white flash on the way to a dark page. All three belong to the document, and the document belongs to the runtime.

So the runtime owns the *mechanism* and the theme owns the *appearance*.

**1. Declare which modes you are actually drawn for** — in `theme.json`:

```json
"colorModes": { "supports": ["light", "dark"], "default": "system" }
```

This is a capability, not a preference. A theme with only a dark palette says `"supports": ["dark"]`, and the runtime then *forces* dark and renders no switch — rather than offering a reader a light mode the theme has no colours for. Omit `colorModes` entirely and you get both modes, following the OS.

**2. Put the switch wherever your design wants it:**

```tsx
import { ColorModeToggle } from "@zcmsorg/theme-sdk";

<ColorModeToggle ctx={ctx} className="mytheme__icon-btn" />
```

It is static HTML. The runtime wires up the click, remembers the choice, and swaps the icon; the component renders `null` on a single-mode theme, so you cannot ship a dead button. Pass `lightIcon` / `darkIcon` to use your own glyphs, and translate its label with a `colorMode.toggle` key in your locale files.

**3. Style the two modes in CSS**, keyed off the attribute the runtime sets on `<html>`:

```css
.mytheme            { --paper: #ffffff; --ink: #161615; }
html[data-theme="dark"] .mytheme { --paper: #11110f; --ink: #f3f0e8; }

/* Optional: honour the OS for a reader with JavaScript disabled. The
   :not([data-theme]) guard means this can never override a visitor who chose. */
@media (prefers-color-scheme: dark) {
  html:not([data-theme]) .mytheme { --paper: #11110f; --ink: #f3f0e8; }
}
```

Branch in **CSS, not in markup**. `ctx.colorMode` deliberately carries no *current* mode: the server does not know which mode this visitor is in, only their browser does, and a template that branched on a guess would render one thing on the server and another on the client — which is exactly the flash this design exists to prevent. What `ctx.colorMode` does carry is `{ modes, default, toggleable, attribute }`, which is what a theme needs to decide whether to draw a switch at all.

Offering the site owner a starting mode is one settings property:

```json
"colorMode": {
  "type": "string", "title": "Default colour mode",
  "enum": ["system", "light", "dark"], "default": "system"
}
```

A visitor who uses the switch always keeps their own choice over it.

## Real content on a front page: collections

A template is handed the ONE page being rendered. That is enough for a post and an archive, and not enough for a front page: a magazine's front page wants the lead story and six headlines, a shop's wants three products. A theme with no way to ask would have to invent them — and a news theme whose front page does not show your news is a brochure, not a theme.

So a theme **declares** the lists it needs, in `theme.json`:

```json
"collections": {
  "latest":   { "contentType": "post",    "limit": 6, "sort": "newest" },
  "featured": { "contentType": "product", "limit": 3 }
}
```

cms-api runs each query while it builds the page — published rows only, in the locale being rendered, capped at 24 — and the rows arrive on `ctx.collections` under the same names:

```tsx
const latest = ctx.collections.latest ?? [];

{latest.length === 0 ? (
  <p>{ctx.t("latest.empty")}</p>          // a new site has no posts. Say so.
) : (
  latest.map((post) => (
    <article key={post.id}>
      <a href={ctx.url(post.path)}>{post.title}</a>
      <p>{post.excerpt}</p>
    </article>
  ))
)}
```

Declared, not queried. There is no `where`, no operators, no raw filter: a marketplace theme is code written by a stranger, and anything expressive enough to be useful to them is expressive enough to read rows they were never meant to see. A theme that needs more than "the N most recent items of this type" is asking for a plugin — which has permissions and a sandbox.

**Always render the empty state.** `ctx.collections.latest` is `[]` on a site where nobody has written anything yet, and a section that renders nothing at all is indistinguishable from a bug — to the owner of that site, on their first day.

### The editor's version of the same thing

`core/content-list` is a core block whose props are a *query* rather than content, so an editor can put "the latest six posts" on any page from the page builder. cms-api resolves it and the rows arrive in `props.items`, already fetched:

```tsx
blocks: {
  "core/content-list": ({ props, ctx }) => {
    const items = list(props.items);          // resolved server-side
    const grid = props.layout === "grid";     // a hint, not a command
    …
  },
}
```

A theme should register it, exactly as it registers `core/richtext` — otherwise an editor who inserts a list gets a blank space on that theme.

## Rendering authored HTML: the `html` prop, and nothing else

A rich-text block carries HTML an author typed, and the only way to render it is `dangerouslySetInnerHTML`. That is safe **only** because cms-api sanitises it on the way IN — at write time, against a strict allowlist — before it is ever stored.

The rule that makes that guarantee real:

> **A theme may only pass a prop named `html` to `dangerouslySetInnerHTML`.**

```tsx
// Safe: `html` is the prop core sanitises.
<div dangerouslySetInnerHTML={{ __html: str(props.html) }} />

// NOT safe: core has no idea this prop was going to be treated as markup.
<div dangerouslySetInnerHTML={{ __html: str(props.body) }} />   // ✗
```

`html` is the one name the platform standardises on, so it is the one name the sanitiser knows to clean. Every other prop is text: React escapes it, and core deliberately does *not* run a sanitiser over it — doing so would entity-escape a `<` an editor legitimately typed into a heading.

The site's Content-Security-Policy (`script-src 'self' 'nonce-…'`, no `unsafe-inline`) refuses any inline script or event handler that somehow survived. That is a **backstop**, not the defence. Do not rely on it: it does not stop an `<iframe>`, and a theme that invents its own HTML-bearing prop is a theme that has stepped outside the guarantee.

## Plugin integrations

A theme never imports a plugin. It feature-detects a capability, reads only the
public projection approved by core, and chooses where runtime-owned interactive
UI is mounted:

```json
"optionalCapabilities": ["ai.assistant"],
"integrationSlots": ["floating"]
```

```tsx
const assistant = ctx.getIntegration<{ name: string }>("ai.assistant");

return (
  <div>
    {assistant ? <p>Chat with {assistant.data.name}</p> : null}
    {ctx.renderSlot("floating")}
  </div>
);
```

The plugin's private settings and credentials never enter `ThemeContext`.
Themes published before slots were introduced receive floating integrations from
the runtime compatibility fallback.

## Docs

- [Architecture](https://github.com/zscontributor/z-cms/blob/main/docs/architecture.md)
- [Packaging, signing and distribution](https://github.com/zscontributor/z-cms/blob/main/docs/distribution.md)
- [Translations](https://github.com/zscontributor/z-cms/blob/main/docs/i18n.md)

## License

MIT © Z-SOFT Co., Ltd.
