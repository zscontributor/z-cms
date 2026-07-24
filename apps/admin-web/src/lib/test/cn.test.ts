import { describe, expect, it } from "vitest";
import { cn } from "../cn";

describe("cn", () => {
  it("joins truthy class names with a single space", () => {
    expect(cn("a", "b", "c")).toBe("a b c");
  });

  it("drops the falsey parts a conditional className produces", () => {
    // `cond && "x"` yields false when off; the joiner must not leave "false" or a
    // stray double space in the class string.
    expect(cn("a", false, null, undefined, "b")).toBe("a b");
  });

  it("returns an empty string when every part is falsey", () => {
    expect(cn(false, null, undefined)).toBe("");
  });
});
