import { describe, expect, it } from "vitest";
import { RETURN_PARAM, returnHref, searchOf, withReturnTo } from "../return-to";

describe("withReturnTo", () => {
  it("carries the list's query as one escaped parameter", () => {
    const href = withReturnTo("/x/crm/leads/42", "page=5&q=ann");
    expect(href).toBe(`/x/crm/leads/42?${RETURN_PARAM}=page%3D5%26q%3Dann`);
  });

  it("leaves the link alone when the list is at its default state", () => {
    expect(withReturnTo("/orders/7", "")).toBe("/orders/7");
    expect(withReturnTo("/orders/7", undefined)).toBe("/orders/7");
  });

  it("appends to a link that already carries a parameter", () => {
    expect(withReturnTo("/content/post/new?locale=vi", "page=2")).toBe(
      `/content/post/new?locale=vi&${RETURN_PARAM}=page%3D2`,
    );
  });

  it("does not nest a return inside a return", () => {
    expect(withReturnTo("/orders/7", `${RETURN_PARAM}=page%3D9`)).toBe("/orders/7");
  });
});

describe("returnHref", () => {
  it("puts the reader back on the page they left", () => {
    expect(returnHref("/x/crm/leads", "page=5&q=ann")).toBe("/x/crm/leads?page=5&q=ann");
  });

  it("falls back to the list itself when nothing was carried", () => {
    expect(returnHref("/orders", undefined)).toBe("/orders");
    expect(returnHref("/orders", "")).toBe("/orders");
  });

  it("cannot be talked into leaving the list path", () => {
    // The parameter is data, not a URL: whatever it holds comes back out as
    // escaped key=value pairs on the path the caller asked for.
    expect(returnHref("/orders", "//evil.example.com")).toBe(
      "/orders?%2F%2Fevil.example.com=",
    );
    expect(returnHref("/orders", "https://evil.example.com/?a=1")).toContain("/orders?");
  });

  it("reads the first value when the parameter is repeated", () => {
    expect(returnHref("/orders", ["page=2", "page=9"])).toBe("/orders?page=2");
  });
});

describe("searchOf", () => {
  it("drops the parameters a list never set", () => {
    expect(searchOf({ page: "5", status: undefined, q: "" })).toBe("page=5");
  });

  it("never carries a stale return parameter into a new one", () => {
    expect(searchOf({ page: "5", [RETURN_PARAM]: "page=1" })).toBe("page=5");
  });
});
