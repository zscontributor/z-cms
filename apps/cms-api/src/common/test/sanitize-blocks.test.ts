import { describe, expect, it } from "vitest";
import { sanitizeBlocks, sanitizeRichText } from "../sanitize-blocks";

function richtext(html: string, over: Record<string, unknown> = {}) {
  return [{ id: "b1", type: "core/richtext", props: { html, ...over } }];
}

/** The `html` prop of the first block, after sanitising. */
function htmlOf(blocks: unknown): string {
  return (sanitizeBlocks(blocks)[0] as any).props.html as string;
}

describe("sanitizeRichText", () => {
  describe("script execution", () => {
    it("strips a <script> tag", () => {
      expect(sanitizeRichText("<p>hi</p><script>alert(1)</script>")).toBe("<p>hi</p>");
    });

    it("strips the script body, not just the tag", () => {
      // A sanitiser that dropped <script> but kept its text would render the
      // payload as visible page text — ugly, but worse, it would still be there
      // for anything downstream that re-parsed the HTML.
      expect(sanitizeRichText("<script>alert(1)</script>")).not.toContain("alert");
    });

    it("strips an onerror handler", () => {
      const out = sanitizeRichText('<img src="/x.png" onerror="alert(1)">');
      expect(out).not.toContain("onerror");
      expect(out).toContain('src="/x.png"');
    });

    it("strips an onclick handler", () => {
      const out = sanitizeRichText('<p onclick="alert(1)">hi</p>');
      expect(out).not.toContain("onclick");
      expect(out).toContain("hi");
    });
  });

  describe("tags the CSP would NOT stop", () => {
    // The whole reason sanitising is the defence and CSP is only the backstop.
    it("drops an <iframe>", () => {
      expect(sanitizeRichText('<iframe src="https://evil.test"></iframe>')).not.toContain(
        "iframe",
      );
    });

    it("drops an <object>", () => {
      expect(sanitizeRichText('<object data="evil.swf"></object>')).not.toContain("object");
    });

    it("drops a <form>", () => {
      // A form is how stored HTML phishes for a password on the site's own domain.
      const out = sanitizeRichText(
        '<form action="https://evil.test"><input name="pw"></form>',
      );
      expect(out).not.toContain("form");
      expect(out).not.toContain("input");
    });
  });

  describe("URL schemes", () => {
    it("drops a javascript: href", () => {
      const out = sanitizeRichText('<a href="javascript:alert(1)">x</a>');
      expect(out).not.toContain("javascript:");
    });

    it("keeps the link text when it drops the javascript: href", () => {
      expect(sanitizeRichText('<a href="javascript:alert(1)">click me</a>')).toContain(
        "click me",
      );
    });

    it("drops a data: image src", () => {
      const out = sanitizeRichText(
        '<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">',
      );
      expect(out).not.toContain("data:");
    });

    it("keeps a relative href", () => {
      expect(sanitizeRichText('<a href="/about">About</a>')).toContain('href="/about"');
    });

    it("keeps an https href", () => {
      expect(sanitizeRichText('<a href="https://x.test">X</a>')).toContain(
        'href="https://x.test"',
      );
    });

    it("keeps mailto and tel hrefs", () => {
      expect(sanitizeRichText('<a href="mailto:a@b.test">mail</a>')).toContain("mailto:");
      expect(sanitizeRichText('<a href="tel:+123">call</a>')).toContain("tel:");
    });
  });

  describe("target=_blank", () => {
    it("forces rel=noopener noreferrer", () => {
      const out = sanitizeRichText('<a href="https://x.test" target="_blank">X</a>');
      expect(out).toContain('rel="noopener noreferrer"');
    });

    it("overwrites a rel the author supplied", () => {
      const out = sanitizeRichText(
        '<a href="https://x.test" target="_blank" rel="opener">X</a>',
      );
      expect(out).toContain('rel="noopener noreferrer"');
      expect(out).not.toContain('rel="opener"');
    });
  });

  describe("style and class", () => {
    it("drops a style attribute", () => {
      expect(sanitizeRichText('<p style="position:fixed;inset:0">x</p>')).toBe("<p>x</p>");
    });

    it("drops a class attribute", () => {
      expect(sanitizeRichText('<p class="theme-header">x</p>')).toBe("<p>x</p>");
    });
  });

  /**
   * The test that stops someone "hardening" the allowlist into uselessness.
   * A sanitiser that eats an author's real content is as much a bug as one that
   * lets a script through — it just fails in the other direction, and quietly.
   */
  describe("ordinary formatting survives", () => {
    it("keeps paragraphs, bold and italic", () => {
      const html = "<p>Hello <strong>bold</strong> and <em>italic</em>.</p>";
      expect(sanitizeRichText(html)).toBe(html);
    });

    it("keeps headings", () => {
      const html = "<h1>One</h1><h2>Two</h2><h3>Three</h3>";
      expect(sanitizeRichText(html)).toBe(html);
    });

    it("keeps lists", () => {
      const html = "<ul><li>a</li><li>b</li></ul><ol><li>c</li></ol>";
      expect(sanitizeRichText(html)).toBe(html);
    });

    it("keeps a link with an href and title", () => {
      const html = '<a href="https://x.test" title="X">X</a>';
      expect(sanitizeRichText(html)).toBe(html);
    });

    it("keeps an image with its dimensions and alt text", () => {
      const html = '<img src="/a.png" alt="A" width="10" height="20" loading="lazy" />';
      expect(sanitizeRichText(html)).toContain('src="/a.png"');
      expect(sanitizeRichText(html)).toContain('alt="A"');
      expect(sanitizeRichText(html)).toContain('width="10"');
      expect(sanitizeRichText(html)).toContain('loading="lazy"');
    });

    it("keeps blockquote, code, pre and tables", () => {
      const html =
        "<blockquote><p>q</p></blockquote><pre><code>x</code></pre>" +
        "<table><thead><tr><th>h</th></tr></thead><tbody><tr><td>d</td></tr></tbody></table>";
      expect(sanitizeRichText(html)).toBe(html);
    });

    it("keeps the text inside a tag it drops", () => {
      expect(sanitizeRichText("<marquee>still my words</marquee>")).toContain(
        "still my words",
      );
    });
  });
});

describe("sanitizeBlocks", () => {
  it("sanitises props.html on a block", () => {
    expect(htmlOf(richtext("<p>ok</p><script>alert(1)</script>"))).toBe("<p>ok</p>");
  });

  it("sanitises props.html whatever the block type is", () => {
    // The contract is the PROP NAME, not the type — a theme's own block that takes
    // an `html` prop feeds the same dangerouslySetInnerHTML.
    const blocks = [
      { id: "b1", type: "acme/fancy-banner", props: { html: "<script>alert(1)</script>ok" } },
    ];
    expect(htmlOf(blocks)).toBe("ok");
  });

  it("sanitises nested children, at depth", () => {
    const blocks = [
      {
        id: "b1",
        type: "core/section",
        props: {},
        children: [
          {
            id: "b2",
            type: "core/section",
            props: {},
            children: [
              {
                id: "b3",
                type: "core/richtext",
                props: { html: "<p>deep</p><script>alert(1)</script>" },
              },
            ],
          },
        ],
      },
    ];
    const out = sanitizeBlocks(blocks) as any;
    expect(out[0].children[0].children[0].props.html).toBe("<p>deep</p>");
  });

  /**
   * The design decision, asserted. A prop that is not named `html` is TEXT: React
   * escapes it at render, so there is nothing to sanitise — and running HTML
   * sanitising over it would entity-escape a `<` the author legitimately typed.
   */
  it("leaves a non-html prop byte-identical, angle brackets and all", () => {
    const heading = "a < b && c > d, 5 > 3";
    const blocks = richtext("<p>x</p>", { heading, subtitle: "<not html>" });
    const props = (sanitizeBlocks(blocks)[0] as any).props;

    expect(props.heading).toBe(heading);
    expect(props.subtitle).toBe("<not html>");
  });

  it("does not mutate the input tree", () => {
    const blocks = richtext("<script>alert(1)</script>");
    const before = JSON.stringify(blocks);

    sanitizeBlocks(blocks);

    expect(JSON.stringify(blocks)).toBe(before);
  });

  it("returns a new tree, not the same references", () => {
    const blocks = richtext("<p>x</p>");
    const out = sanitizeBlocks(blocks);

    expect(out[0]).not.toBe(blocks[0]);
    expect(out[0].props).not.toBe(blocks[0].props);
  });

  it("passes through blocks with no html prop untouched", () => {
    const blocks = [{ id: "b1", type: "core/hero", props: { heading: "Hi" } }];
    expect(sanitizeBlocks(blocks)).toEqual(blocks);
  });

  it("tolerates a non-array input", () => {
    expect(sanitizeBlocks(undefined)).toEqual([]);
    expect(sanitizeBlocks(null)).toEqual([]);
  });

  it("tolerates a non-string html prop", () => {
    const blocks = [{ id: "b1", type: "core/richtext", props: { html: 42 } }];
    expect((sanitizeBlocks(blocks)[0] as any).props.html).toBe(42);
  });
});
