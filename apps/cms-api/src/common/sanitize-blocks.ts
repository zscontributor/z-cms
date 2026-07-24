import sanitizeHtml from "sanitize-html";
import type { Block } from "@zcmsorg/schemas";

/**
 * Rich text is stored as HTML and rendered by themes with `dangerouslySetInnerHTML`.
 * That makes stored HTML executable-by-default, so it is sanitised HERE — at the
 * write boundary, in cms-api, which is the only process that persists blocks.
 *
 * THE CONTRACT
 *
 * `sanitizeBlocks` walks a block tree (including `children`) and sanitises exactly
 * ONE prop: the one named `html`. On every block, whatever its `type`. It returns a
 * NEW tree; the input is never mutated.
 *
 * It deliberately does NOT sanitise other string props, and that is the whole design:
 *
 *   - Every other prop is TEXT. A theme renders it as a React child, and React escapes
 *     it — `{props.heading}` cannot introduce markup, ever. There is nothing to sanitise.
 *   - Running an HTML sanitiser over text would CORRUPT it: an editor who legitimately
 *     types `a < b` in a heading would have it silently rewritten to `a &lt; b` and would
 *     see the entity, literally, on their page. A sanitiser that damages honest content
 *     is a bug, not extra safety.
 *   - The attack surface is precisely the set of props a theme feeds to
 *     `dangerouslySetInnerHTML`, and `html` is the name the platform standardises on for
 *     that. Sanitise that name and the surface is covered; sanitise more and we only
 *     break text.
 *
 * A theme that invents a second raw-HTML prop under another name is therefore outside
 * this guarantee — which is why `html` is a platform convention and not a theme's choice.
 *
 * The public site's CSP (`script-src 'self' 'nonce-…' 'strict-dynamic'`, no
 * `unsafe-inline`) is the BACKSTOP, not the defence: it would refuse to run an inline
 * `<script>` that somehow reached a page, but it does not stop `<iframe>`, `<form>`,
 * `<object>` or `href="javascript:"`. Those are stopped here.
 */

/** Tags a rich-text field may contain. Everything else is dropped. */
const ALLOWED_TAGS = [
  "p", "br", "hr",
  "strong", "b", "em", "i", "u", "s",
  "code", "pre", "blockquote",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li",
  "a", "img",
  "figure", "figcaption",
  "table", "thead", "tbody", "tr", "th", "td",
  "span", "div",
];

/**
 * Attributes, per tag. Everything not listed is dropped — which is what removes
 * every `on*` handler without needing to enumerate them.
 *
 * No `style`: CSS alone can exfiltrate (an attribute selector plus a background
 * `url()` leaks a value character by character) and can overlay the page with an
 * invisible full-viewport element that hijacks clicks. No `class` either: a class
 * is meaningless without the theme's stylesheet, and letting authored HTML claim
 * a theme's class names lets it impersonate the site's own chrome.
 */
const ALLOWED_ATTRIBUTES: sanitizeHtml.IOptions["allowedAttributes"] = {
  a: ["href", "title", "target", "rel"],
  img: ["src", "alt", "title", "width", "height", "loading"],
};

/**
 * Schemes a URL may carry. Relative and protocol-relative URLs are allowed
 * separately, below.
 *
 * NOT `javascript:` — that is a script in an `href`. NOT `data:` either, even on an
 * `<img>`: a `data:` URI is how a payload is smuggled past anything that inspects
 * URLs rather than content (`data:image/svg+xml` is an SVG, and an SVG is a document
 * that can carry script).
 */
const ALLOWED_SCHEMES = ["http", "https", "mailto", "tel"];

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: ALLOWED_ATTRIBUTES,
  allowedSchemes: ALLOWED_SCHEMES,
  // A relative href ("/about") carries no scheme and is how internal links are written.
  allowProtocolRelative: true,
  allowedSchemesAppliedToAttributes: ["href", "src"],
  // Drop the tag but KEEP its text. Sanitising must not silently eat an author's
  // words just because they wrapped them in a tag we do not allow.
  disallowedTagsMode: "discard",
  transformTags: {
    /**
     * `target="_blank"` without `rel="noopener"` hands the opened page a live
     * `window.opener` handle back to ours, and it can navigate us somewhere else
     * (reverse tabnabbing). Forced, not merely allowed, because an author pasting
     * HTML will not think of it.
     */
    a: (tagName, attribs) => {
      if (attribs.target === "_blank") {
        return { tagName, attribs: { ...attribs, rel: "noopener noreferrer" } };
      }
      return { tagName, attribs };
    },
  },
};

/** Sanitises one rich-text HTML string. Exported for tests and for reuse. */
export function sanitizeRichText(html: string): string {
  return sanitizeHtml(html, OPTIONS);
}

/**
 * Returns a new block tree with every `props.html` sanitised, at every depth.
 *
 * Tolerant of shapes that are not blocks (a caller may hand us raw input that has not
 * been through `BlockDocumentSchema` yet): anything that is not an object is passed
 * through untouched rather than throwing. Validation is a separate gate, and it is the
 * caller's job to run it — see `contents.service.ts` and `themes.module.ts`.
 */
export function sanitizeBlocks(blocks: unknown): Block[] {
  if (!Array.isArray(blocks)) return [] as Block[];
  return blocks.map((block) => sanitizeBlock(block)) as Block[];
}

function sanitizeBlock(block: unknown): unknown {
  if (!block || typeof block !== "object" || Array.isArray(block)) return block;

  const node = block as Record<string, unknown>;
  const out: Record<string, unknown> = { ...node };

  const props = node.props;
  if (props && typeof props === "object" && !Array.isArray(props)) {
    const nextProps: Record<string, unknown> = { ...(props as Record<string, unknown>) };
    // The one prop, and only this one. See the contract at the top of this file.
    if (typeof nextProps.html === "string") {
      nextProps.html = sanitizeRichText(nextProps.html);
    }
    out.props = nextProps;
  }

  if (Array.isArray(node.children)) {
    out.children = node.children.map((child) => sanitizeBlock(child));
  }

  return out;
}
