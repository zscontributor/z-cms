import { BASE_LOCALE, t } from "@zcmsorg/i18n";
import { DEFAULT_SITE_BRAND } from "@zcmsorg/schemas";
import type { RenderPayload } from "@zcmsorg/schemas";
import { buildThemeContext } from "@/lib/theme-context";
import { DEFAULT_THEME_KEY, resolveTheme } from "@/lib/theme-registry";
import { currentHostname, resolveChrome } from "@/lib/render-client";

/**
 * The 404 page, rendered inside the site's own theme.
 *
 * Next serves this with a real 404 status whenever a route calls notFound(). To
 * draw it in the right theme it needs the site chrome, which it gets from the
 * homepage resolve — the single hottest cache entry on the site, so this costs no
 * uncached round trip in practice. The page's own (missing) content is ignored.
 *
 * When even the chrome cannot be had — an unknown hostname, or cms-api down — it
 * falls back to the default theme with its manifest defaults. A 404 must never be
 * the thing that 500s.
 */

/** Enough of a payload to build a ThemeContext with nothing but manifest defaults. */
const FALLBACK_PAYLOAD: RenderPayload = {
  site: {
    id: "",
    name: "",
    // Empty, like the id and the name: this payload renders when no site was
    // resolved, so there is no canonical host to send anyone to.
    canonicalHost: "",
    locale: BASE_LOCALE,
    defaultLocale: BASE_LOCALE,
    locales: [BASE_LOCALE],
    // The platform's brand, not a site's: this payload is what renders when we do
    // not know which site was asked for. A theme still reads ctx.site.brand here,
    // so it has to be a real brand rather than a hole.
    brand: DEFAULT_SITE_BRAND,
  },
  theme: { key: DEFAULT_THEME_KEY, version: "0.0.0", settings: {} },
  menus: {},
  content: null,
  archive: null,
  // A 404 offers no translations: there is no page here to have any.
  alternates: [],
  capabilities: [],
  integrations: {},
  // No site was resolved, so there is nothing to list. A theme whose 404 template
  // reaches for a collection gets an empty one and renders its empty state — which
  // is the correct thing to show on a page that is itself about absence.
  collections: {},
};

async function chromePayload(): Promise<RenderPayload> {
  try {
    const hostname = await currentHostname();
    const payload = await resolveChrome(hostname);
    return payload ?? FALLBACK_PAYLOAD;
  } catch (error) {
    console.error("[404] Could not load site chrome; using default theme.", error);
    return FALLBACK_PAYLOAD;
  }
}

export default async function NotFound() {
  const payload = await chromePayload();
  const { theme, assetBase } = await resolveTheme(
    payload.theme.key,
    payload.theme.version,
    payload.theme.origin,
  );
  const ctx = buildThemeContext(theme, payload, assetBase);
  const translate = t(payload.site.locale);
  const { Layout, templates } = theme;
  const legacyFloatingIntegration = theme.manifest.integrationSlots?.includes("floating")
    ? null
    : ctx.renderSlot("floating");

  const NotFoundTemplate = templates.notFound;
  const ErrorTemplate = templates.error;

  return (
    <Layout ctx={ctx}>
      {NotFoundTemplate ? (
        <NotFoundTemplate ctx={ctx} />
      ) : ErrorTemplate ? (
        <ErrorTemplate
          ctx={ctx}
          statusCode={404}
          title={ctx.t("notFound.title")}
          message={ctx.t("notFound.description")}
        />
      ) : (
        // A theme is not required to ship a notFound template; the runtime always
        // has something to put in the hole. Its words are the platform's, not the
        // theme's, so they come from the core catalogue rather than ctx.t — the
        // theme that would have owned them is precisely the one that is missing.
        <div className="mx-auto max-w-3xl px-4 py-24 text-center">
          <h1 className="text-4xl font-black tracking-tight">404</h1>
          <p className="mt-4 text-slate-600">{translate("site.notFound.title")}</p>
          <a href={ctx.url("/")} className="mt-6 inline-block underline underline-offset-4">
            {translate("site.notFound.backHome")}
          </a>
        </div>
      )}
      {legacyFloatingIntegration}
    </Layout>
  );
}
