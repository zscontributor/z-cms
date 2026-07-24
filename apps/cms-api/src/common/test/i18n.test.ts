import { describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { LocaleMiddleware, currentLocale, t } from "../i18n";

/**
 * The locale rides in AsyncLocalStorage so every error string a request throws
 * comes out in the caller's language. The risk if this regresses is not a crash
 * but a silent one: Vietnamese admins reading English toasts, with no test
 * failing to say so.
 */

function run(acceptLanguage: string | undefined, inside: () => void): void {
  const middleware = new LocaleMiddleware();
  const req = { headers: { "accept-language": acceptLanguage } } as unknown as Request;
  const next: NextFunction = () => inside();
  middleware.use(req, {} as Response, next);
}

describe("currentLocale", () => {
  it("falls back to the base locale outside any request", () => {
    expect(currentLocale()).toBe("en");
  });

  it("reports the negotiated locale inside the request store", () => {
    let seen = "";
    run("vi", () => {
      seen = currentLocale();
    });

    expect(seen).toBe("vi");
  });
});

describe("t", () => {
  it("translates a key into the request's negotiated language", () => {
    let message = "";
    run("vi", () => {
      message = t()("errors.content.notFound");
    });

    expect(message).toBe("Không tìm thấy nội dung.");
  });

  it("translates the same key into English for an English request", () => {
    let message = "";
    run("en", () => {
      message = t()("errors.content.notFound");
    });

    expect(message).toBe("Content not found.");
  });

  it("interpolates named parameters into the message", () => {
    let message = "";
    run("en", () => {
      message = t()("errors.plugins.notFound", { key: "zsoft-seo" });
    });

    expect(message).toContain("zsoft-seo");
  });
});

describe("LocaleMiddleware", () => {
  it("calls next exactly once so the request proceeds", () => {
    const middleware = new LocaleMiddleware();
    const next = vi.fn();
    const req = { headers: { "accept-language": "en" } } as unknown as Request;

    middleware.use(req, {} as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("negotiates the base locale when no Accept-Language is sent", () => {
    let seen = "";
    run(undefined, () => {
      seen = currentLocale();
    });

    expect(seen).toBe("en");
  });
});
