import { Injectable, type NestMiddleware } from "@nestjs/common";
import {
  BASE_LOCALE,
  SUPPORTED_LOCALES,
  negotiateLocale,
  t as translator,
  type Translate,
} from "@zcmsorg/i18n";
import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";

/**
 * The language an API response speaks.
 *
 * An error message from this API is read by a human — it ends up in a toast in
 * the admin — so it is translated here rather than shipped as a code the client
 * has to look up. The caller says which language it wants the way HTTP has always
 * said it: `Accept-Language`.
 *
 * The locale rides in AsyncLocalStorage rather than being threaded through every
 * service signature. Passing a locale down four layers to build one error string
 * is the kind of parameter that gets dropped, and a dropped locale is a message
 * in the wrong language with no test to catch it.
 */
const store = new AsyncLocalStorage<string>();

/** The locale of the request in flight, or the base locale outside a request. */
export function currentLocale(): string {
  return store.getStore() ?? BASE_LOCALE;
}

/**
 * The translator for the request in flight.
 *
 *   throw new NotFoundException(t()("errors.content.notFound"));
 */
export function t(): Translate {
  return translator(currentLocale());
}

/**
 * Middleware, not an interceptor.
 *
 * Nest runs guards *before* interceptors, so a locale set by an interceptor
 * would not exist yet when `AuthGuard` throws — and "wrong credentials" is
 * precisely a message a user reads. Middleware runs before the guard, so every
 * exception raised anywhere in the request already has a language.
 */
@Injectable()
export class LocaleMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    const locale = negotiateLocale(req.headers["accept-language"], SUPPORTED_LOCALES);
    store.run(locale, () => next());
  }
}
