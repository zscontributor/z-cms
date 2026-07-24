import type { INestApplication } from "@nestjs/common";
import {
  BASE_LOCALE,
  SUPPORTED_LOCALES,
  negotiateLocale,
  t as translator,
} from "@zcmsorg/i18n";
import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * What `/api/v1/docs` says when the docs are switched off.
 *
 * Without this the route simply does not exist, and Express answers
 * `Cannot GET /api/v1/docs` — which reads as "you got the URL wrong" when the
 * truth is "this instance chose not to serve them". Those are different problems
 * with different fixes, and the operator who set `SWAGGER_ENABLED=false` months
 * ago is exactly the person who will not remember which one they are looking at.
 *
 * Still a 404, not a 200: there is genuinely nothing at this URL. The status is
 * for the machine; the page is for the human.
 */
export function serveDocsDisabledPage(
  app: INestApplication,
  paths: { docs: string; docsJson: string },
): void {
  const explain = (req: Request, res: Response, alwaysJson: boolean): void => {
    // The locale is negotiated here rather than read from the request-scoped
    // store: this handler sits outside Nest's routing, so nothing guarantees
    // LocaleMiddleware has run by the time it is reached.
    const locale = negotiateLocale(req.headers["accept-language"], SUPPORTED_LOCALES);
    const t = translator(locale);

    const title = t("errors.docs.title");
    const body = t("errors.docs.body");
    const hint = t("errors.docs.hint", { path: paths.docs });

    // `accepts(["json", "html"])`, not `accepts("html")`. curl sends `Accept: */*`,
    // which *does* match html — asking whether html is acceptable therefore hands a
    // pipe full of HTML to a client that wanted JSON. Asking which of the two it
    // prefers gets it right: a browser ranks text/html above the wildcard and gets
    // the page, while `*/*` falls through to the first type listed here.
    const wantsHtml = !alwaysJson && req.accepts(["json", "html"]) === "html";

    if (!wantsHtml) {
      res.status(404).json({
        statusCode: 404,
        error: "Not Found",
        message: `${title}. ${body}`,
        hint,
      });
      return;
    }

    const health = t("errors.docs.health", { url: "/api/v1/health" });
    res.status(404).type("html").send(page({ locale, title, body, hint, health }));
  };

  const server = app.getHttpAdapter().getInstance() as {
    get(path: string, handler: RequestHandler): void;
  };

  server.get(paths.docs, (req: Request, res: Response, _next: NextFunction) =>
    explain(req, res, false),
  );

  // The JSON document has no human form: whoever fetches it is a generator, a
  // client or a script, and handing that an HTML page is how a build breaks with
  // a parse error instead of a message it could have printed.
  server.get(paths.docsJson, (req: Request, res: Response, _next: NextFunction) =>
    explain(req, res, true),
  );
}

/** Escapes text before it goes into HTML. The strings are ours, but the habit is not negotiable. */
const escape = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );

interface PageStrings {
  locale: string;
  title: string;
  body: string;
  hint: string;
  health: string;
}

/**
 * One self-contained page: no stylesheet, no script, no font to fetch.
 *
 * The API's Content-Security-Policy permits inline styles on this path and
 * nothing else, and a page that explains a *disabled* feature has no business
 * pulling assets over the network to do it.
 */
function page({ locale, title, body, hint, health }: PageStrings): string {
  return `<!doctype html>
<html lang="${escape(locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escape(title)} — Z-CMS</title>
<style>
  :root { color-scheme: light dark; --fg: #18181b; --muted: #71717a; --bg: #fafafa; --card: #fff; --line: #e4e4e7; --code: #f4f4f5; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #fafafa; --muted: #a1a1aa; --bg: #09090b; --card: #18181b; --line: #27272a; --code: #27272a; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 1.5rem;
    background: var(--bg); color: var(--fg);
    font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  }
  main { max-width: 34rem; width: 100%; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 2rem; }
  .code { font: 600 0.75rem/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .08em; color: var(--muted); }
  h1 { margin: .75rem 0 0; font-size: 1.5rem; line-height: 1.3; }
  p { margin: .75rem 0 0; color: var(--muted); }
  .hint { margin-top: 1.25rem; padding: .875rem 1rem; background: var(--code); border-radius: 8px; color: var(--fg); font-size: .9375rem; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .875em; }
  a { color: inherit; }
  footer { margin-top: 1.5rem; padding-top: 1rem; border-top: 1px solid var(--line); font-size: .875rem; }
</style>
</head>
<body>
<main>
  <div class="code">404 · SWAGGER_ENABLED=false</div>
  <h1>${escape(title)}</h1>
  <p>${escape(body)}</p>
  <p class="hint">${escape(hint)}</p>
  <footer><a href="/api/v1/health">${escape(health)}</a></footer>
</main>
</body>
</html>
`;
}
