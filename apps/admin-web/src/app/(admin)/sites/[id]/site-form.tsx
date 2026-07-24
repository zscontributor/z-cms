"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { LocaleInfo } from "@zcmsorg/i18n";
import { HOSTNAME_RE, normalizeHostname, type SiteDto } from "@zcmsorg/schemas";
import { updateSiteAction } from "@/app/actions/site";
import { MediaPickerField } from "@/components/editor/media-picker";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { useT } from "@/lib/i18n-provider";

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

/**
 * The site's name, its brand, and whether it is published.
 *
 * The brand is the reason this screen exists. Colour and logo are set ONCE, here,
 * and every theme reads them through `ctx.site.brand` — so switching theme keeps
 * the customer's identity instead of throwing it away. A theme may still override
 * either one in its own settings, for the owner who wants this theme to look
 * different; leaving those blank is what lets the site's brand show through.
 */
export function SiteForm({
  site,
  canUpdate,
  locales,
}: {
  site: SiteDto;
  canUpdate: boolean;
  locales: LocaleInfo[];
}) {
  const t = useT();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [name, setName] = useState(site.name);
  const [slug, setSlug] = useState(site.slug);
  const [hostname, setHostname] = useState(
    site.domains.find((domain) => domain.isPrimary)?.hostname ?? site.domains[0]?.hostname ?? "",
  );
  const [defaultLocale, setDefaultLocale] = useState(site.defaultLocale);
  const [primaryColor, setPrimaryColor] = useState(site.brand.primaryColor);
  const [logo, setLogo] = useState(site.brand.logo);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const published = site.status === "PUBLISHED";
  const effectiveHostname = normalizeHostname(hostname);
  const hostnameValid = HOSTNAME_RE.test(effectiveHostname);
  const hostnameError = effectiveHostname && !hostnameValid;

  function save(patch: Parameters<typeof updateSiteAction>[1]) {
    setResult(null);
    startTransition(async () => {
      const res = await updateSiteAction(site.id, patch);
      setResult(
        res.ok ? { ok: true, message: res.message } : { ok: false, message: res.error },
      );
      if (res.ok) router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      {!published ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
          {t("admin.sites.draftNotice")}
        </div>
      ) : null}

      <form
        className="z-card space-y-6 p-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canUpdate || pending) return;
          if (!slug || !hostnameValid) return;
          save({
            name: name.trim() || site.name,
            slug,
            hostname: effectiveHostname,
            defaultLocale,
            // The colour is validated by the API as a six-digit hex; the native
            // colour input can only ever produce one, so the two agree.
            brand: { primaryColor, logo },
          });
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("admin.sites.name")} htmlFor="site-name">
            <Input
              id="site-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={!canUpdate || pending}
            />
          </Field>

          <Field
            label={t("admin.sites.slug")}
            htmlFor="site-slug"
            hint={t("admin.sites.slugHelp")}
          >
            <Input
              id="site-slug"
              value={slug}
              onChange={(event) => setSlug(slugify(event.target.value))}
              disabled={!canUpdate || pending}
              autoComplete="off"
            />
          </Field>

          <Field
            label={t("admin.sites.hostname")}
            htmlFor="site-hostname"
            hint={t("admin.sites.hostnameHelp")}
          >
            <Input
              id="site-hostname"
              value={hostname}
              onChange={(event) => setHostname(event.target.value)}
              onBlur={() => setHostname(effectiveHostname)}
              disabled={!canUpdate || pending}
              placeholder="localhost:3100"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={hostnameError || undefined}
            />
            {hostnameError ? (
              <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
                {t("admin.sites.hostnameInvalid")}
              </p>
            ) : effectiveHostname && effectiveHostname !== hostname.trim() ? (
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                {t("admin.sites.hostnameNormalized", { hostname: effectiveHostname })}
              </p>
            ) : null}
          </Field>

          <Field label={t("admin.sites.defaultLocale")} htmlFor="site-locale">
            <Select
              id="site-locale"
              value={defaultLocale}
              onChange={(event) => setDefaultLocale(event.target.value)}
              disabled={!canUpdate || pending}
            >
              {locales.map((locale) => (
                <option key={locale.code} value={locale.code}>
                  {locale.nativeName} ({locale.code})
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="border-t border-[var(--border)] pt-5">
          <h2 className="text-sm font-semibold">{t("admin.sites.brand")}</h2>
          <p className="mt-0.5 text-[11px] leading-4 z-muted">{t("admin.sites.brandHelp")}</p>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label={t("admin.sites.primaryColor")} htmlFor="site-color">
              <div className="flex items-center gap-2">
                <input
                  id="site-color"
                  type="color"
                  value={primaryColor}
                  onChange={(event) => setPrimaryColor(event.target.value)}
                  disabled={!canUpdate || pending}
                  className="h-9 w-12 shrink-0 cursor-pointer rounded-md border border-[var(--border-strong)] bg-transparent p-1"
                />
                {/* The hex is editable as text too: designers arrive with a hex
                    code from a brand guide, not with a colour wheel. */}
                <Input
                  aria-label={t("admin.sites.primaryColor")}
                  value={primaryColor}
                  onChange={(event) => {
                    const next = event.target.value.trim();
                    setPrimaryColor(next.startsWith("#") ? next : `#${next}`);
                  }}
                  disabled={!canUpdate || pending}
                  spellCheck={false}
                  className="font-mono"
                />
              </div>
            </Field>

            <Field
              label={t("admin.sites.logo")}
              hint={t("admin.sites.logoHelp")}
              htmlFor="site-logo"
            >
              <MediaPickerField
                id="site-logo"
                value={logo}
                onChange={setLogo}
                // The URL, not the media id: this value is handed to themes as
                // `ctx.site.brand.logo` and goes straight into an <img src>. A
                // theme cannot resolve a media id — it has no API to ask.
                mode="url"
              />
            </Field>
          </div>

          {/* What the theme will actually be handed. Shown against both a light and
              a dark backdrop because a logo that is invisible on one of them is the
              single most common thing to get wrong here, and the admin is the only
              place to notice it before a visitor does. */}
          <div className="mt-4">
            <p className="mb-1.5 text-[11px] uppercase tracking-wider z-muted">
              {t("admin.sites.logo")}
            </p>
            {logo ? (
              <div className="grid max-w-md grid-cols-2 gap-2">
                <div className="flex h-16 items-center justify-center rounded-md border border-[var(--border)] bg-white px-3">
                  <img src={logo} alt="" className="max-h-10 max-w-full object-contain" />
                </div>
                <div className="flex h-16 items-center justify-center rounded-md border border-[var(--border)] bg-slate-900 px-3">
                  <img src={logo} alt="" className="max-h-10 max-w-full object-contain" />
                </div>
              </div>
            ) : (
              <p className="text-xs z-muted">{t("admin.sites.noLogo")}</p>
            )}
          </div>
        </div>

        {result ? (
          <p
            role="status"
            className={
              result.ok
                ? "text-sm text-emerald-600 dark:text-emerald-400"
                : "text-sm text-red-600 dark:text-red-400"
            }
          >
            {result.message}
          </p>
        ) : null}

        <div className="flex items-center gap-2 border-t border-[var(--border)] pt-5">
          <Button type="submit" disabled={!canUpdate || pending || !slug || !hostnameValid}>
            {pending ? t("admin.sites.saving") : t("admin.sites.save")}
          </Button>

          {/* Publishing is a status change, not a save — it is the one control on
              this page that changes whether the outside world can see the site. */}
          <Button
            type="button"
            variant="secondary"
            disabled={!canUpdate || pending}
            onClick={() => save({ status: published ? "DRAFT" : "PUBLISHED" })}
          >
            {published ? t("admin.sites.unpublish") : t("admin.sites.publish")}
          </Button>
        </div>
      </form>
    </div>
  );
}
