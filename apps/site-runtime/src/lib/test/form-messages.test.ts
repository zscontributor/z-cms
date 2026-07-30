import { describe, expect, it } from "vitest";
import { formMessages } from "../form-messages";

/**
 * The form's words come from the platform catalogue, not from a list of languages
 * typed into a React component.
 *
 * What this is guarding: `FormIsland` used to carry `{ en, vi, ja }` inline, so a
 * site in a fourth language was served English by Z-CMS while its theme spoke the
 * visitor's own — and adding a language meant a code change and a release.
 */
describe("formMessages", () => {
  it("answers in the visitor's language", () => {
    expect(formMessages("vi").send).toBe("Gửi");
    expect(formMessages("ja").send).toBe("送信");
    expect(formMessages("en").send).toBe("Send");
  });

  it("takes a region tag as the language it belongs to", () => {
    expect(formMessages("vi-VN").send).toBe("Gửi");
  });

  it("falls back to the base locale rather than to nothing", () => {
    // A language nobody has translated yet reads English, not a dotted key and
    // not a blank label.
    expect(formMessages("de").send).toBe("Send");
  });

  it("leaves the count in a bounds message for the browser to fill", () => {
    // The number is not known until a value has been measured, and a function
    // cannot cross from a server component to a client one.
    expect(formMessages("vi").min).toContain("{n}");
    expect(formMessages("en").maxLength).toContain("{n}");
  });

  it("resolves every message the island renders", () => {
    // A key that reached the catalogue under a different name would otherwise
    // show up as "site.form.basket" on somebody's checkout.
    for (const [key, value] of Object.entries(formMessages("vi"))) {
      expect(value, key).not.toContain("site.form.");
      expect(value.length, key).toBeGreaterThan(0);
    }
  });
});
