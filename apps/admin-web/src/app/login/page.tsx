import type { Metadata } from "next";
import { Logo } from "@/components/brand";
import { Icon } from "@/components/shell/icon";
import { getT } from "@/lib/locale";
import { siteBranding } from "@/lib/site-branding";
import { LoginForm } from "./login-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  const site = await siteBranding();
  // The tab is the first thing that says which admin this is, and someone signing
  // in to three sites has three of them open.
  return { title: site ? `${t("auth.login.metaTitle")} · ${site.name}` : t("auth.login.metaTitle") };
}

/**
 * Sign in — wearing the colours of the site being signed in to.
 *
 * The admin answers at `/admin` on every tenant hostname, so this page already
 * knows which site it belongs to before anyone types anything: `siteBranding()`
 * resolves the Host header to a site through cms-api's public lookup. When it
 * resolves, the site's own logo and name lead, and there is a link back out to the
 * site itself — someone who reached the login screen by guessing at a URL is far
 * more often looking for the front page than for the admin.
 *
 * When it does not resolve — the dedicated admin hostname, a domain not registered
 * to any site, an API that is down — this is exactly the page it always was. The
 * branding is an improvement on the sign-in screen, never a precondition for it.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const t = await getT();
  const { next } = await searchParams;
  const site = await siteBranding();

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          {/* A tenant's logo is any shape at all, so it is bounded rather than
              sized: capped in height and width, never stretched. Falls back to the
              product mark when the site has not set one. */}
          {site?.logo ? (
            <img
              src={site.logo}
              alt={site.name}
              className="h-10 max-w-[200px] shrink-0 object-contain"
            />
          ) : (
            <Logo size={40} />
          )}
          <div>
            <h1 className="text-lg font-semibold tracking-tight">
              {site ? t("auth.login.titleForSite", { site: site.name }) : t("auth.login.title")}
            </h1>
            <p className="mt-1 text-xs z-muted">{t("auth.login.subtitle")}</p>
          </div>
        </div>

        <div className="z-card p-6 shadow-sm">
          <LoginForm next={next ?? "/"} />
        </div>

        {site ? (
          <div className="mt-5 flex flex-col items-center gap-1.5 text-center">
            {/* Not a Next <Link>: the site is a different app on the same host,
                served by site-runtime, so this leaves the admin entirely. */}
            <a
              href={site.portalUrl}
              className="inline-flex items-center gap-1.5 text-xs z-muted hover:text-[var(--text)]"
            >
              <Icon name="external" size={14} />
              {t("auth.login.visitSite", { host: site.host })}
            </a>
            {/* The mark above is the tenant's now, so the product says its own name
                once, quietly, where it does not compete with theirs. */}
            <p className="text-[11px] z-muted">{t("auth.login.poweredBy")}</p>
          </div>
        ) : null}
      </div>
    </main>
  );
}
