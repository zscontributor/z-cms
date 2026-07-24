import { t as translator } from "@zcmsorg/i18n";
import { PERMISSIONS } from "@zcmsorg/schemas";
import { describe, expect, it } from "vitest";
import {
  describePermission,
  describeStatus,
  isKnownPermission,
} from "../plugin-permissions";

// The real catalogue, in English — the consent screen's copy is exactly what a
// human reads before granting a plugin power, so it is tested against the real
// strings rather than a stub that could not tell "unknown" from "".
const t = translator("en");

describe("isKnownPermission", () => {
  it("recognises a permission that is in the vocabulary", () => {
    expect(isKnownPermission("content:update")).toBe(true);
  });

  it("rejects a scope this build has never heard of", () => {
    expect(isKnownPermission("content:mind-control")).toBe(false);
  });
});

describe("describePermission", () => {
  it("describes a known permission with copy and its sensitivity", () => {
    const copy = describePermission("site:delete", t);
    expect(copy.label).toBeTruthy();
    expect(copy.label).not.toBe("site:delete"); // a real sentence, not the raw scope
    expect(copy.sensitive).toBe(true);
  });

  it("classifies a read-only permission as not sensitive", () => {
    expect(describePermission("content:read", t).sensitive).toBe(false);
  });

  it("gives every permission in the vocabulary a defined, non-undefined label", () => {
    // A hole here would render "undefined" on the consent screen — the one place
    // the admin is deciding whether to trust code.
    for (const permission of PERMISSIONS) {
      const copy = describePermission(permission, t);
      expect(copy.label).toBeTruthy();
      expect(typeof copy.sensitive).toBe("boolean");
    }
  });

  it("shows an unknown permission verbatim and treats it as sensitive", () => {
    // A plugin built against a newer schema can request a scope this build cannot
    // name. Hiding it would be the wrong failure; the safe default is to show it
    // and flag it dangerous — never render `undefined`.
    const copy = describePermission("future:superpower", t);
    expect(copy.label).toBe("future:superpower");
    expect(copy.detail).not.toContain("undefined");
    expect(copy.detail).toBe(t("plugins.permissions.unknown"));
    expect(copy.sensitive).toBe(true);
  });
});

describe("describeStatus", () => {
  it("reports a not-installed plugin as neutral", () => {
    const { label, tone } = describeStatus(null, false, t);
    expect(tone).toBe("neutral");
    expect(label).toBe(t("plugins.status.NOT_INSTALLED"));
  });

  it("gives an active plugin the success tone", () => {
    expect(describeStatus("ACTIVE", true, t).tone).toBe("success");
  });

  it("shows an unrecognised status verbatim rather than guessing a colour", () => {
    // The API may be newer than this build; an unknown status is displayed as-is
    // in a neutral badge instead of being coerced into a wrong tone.
    const { label, tone } = describeStatus("REINDEXING", true, t);
    expect(label).toBe("REINDEXING");
    expect(tone).toBe("neutral");
  });
});
