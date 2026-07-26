"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { LocaleInfo } from "@zcmsorg/i18n";
import { DEFAULT_SITE_BRAND, HOSTNAME_RE, parseHostnameList } from "@zcmsorg/schemas";
import { createSiteAction } from "@/app/actions/site";
import { Checkbox, Field, Input, Select } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n-provider";

/**
 * "Acme Corporation" -> "acme-corporation".
 *
 * Suggested, never enforced: the slug field stays editable, and once someone has
 * typed in it we stop overwriting what they typed. A form that silently rewrites a
 * field the user is editing is a form people learn to fight.
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    // Vietnamese is the first language of this CMS, and "Việt" must become "viet"
    // rather than "vi-t" — so strip the combining marks instead of the letters.
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

export function SiteCreateForm({ locales }: { locales: LocaleInfo[] }) {
  const t = useT();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [hostnames, setHostnames] = useState("");
  const [defaultLocale, setDefaultLocale] = useState(locales[0]?.code ?? "vi");
  const [publish, setPublish] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveSlug = slugTouched ? slug : slugify(name);

  // The domain field is a comma-separated list — "z-soft.com.vn, z-soft.vn" — so a
  // site can answer on more than one address. `parseHostnameList` normalizes and
  // de-duplicates each on every keystroke, which is why the preview below shows what
  // will actually be stored; the first survivor becomes the primary domain.
  const effectiveHostnames = parseHostnameList(hostnames);
  const hostnamesValid =
    effectiveHostnames.length > 0 && effectiveHostnames.every((host) => HOSTNAME_RE.test(host));
  const hostnamesError = hostnames.trim() !== "" && !hostnamesValid;

  const ready = name.trim() && effectiveSlug && hostnamesValid;

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await createSiteAction({
        name: name.trim(),
        slug: effectiveSlug,
        hostnames: effectiveHostnames,
        defaultLocale,
        publish,
        // A site is born with the platform's brand rather than with nothing, so
        // that a theme reading `ctx.site.brand.primaryColor` on the very first
        // render gets a colour instead of an empty string.
        brand: DEFAULT_SITE_BRAND,
      });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      // Straight into the new site's own screen: it is a draft, and the next thing
      // anyone wants is to set its brand and publish it.
      router.push(`/sites/${result.site.id}`);
    });
  }

  return (
    <form
      className="z-card space-y-5 p-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !pending) submit();
      }}
    >
      <div>
        <h2 className="text-sm font-semibold">{t("admin.sites.new")}</h2>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("admin.sites.name")} htmlFor="site-name" required>
          <Input
            id="site-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={pending}
            autoComplete="off"
          />
        </Field>

        <Field
          label={t("admin.sites.slug")}
          htmlFor="site-slug"
          hint={t("admin.sites.slugHelp")}
          required
        >
          <Input
            id="site-slug"
            value={effectiveSlug}
            onChange={(event) => {
              setSlugTouched(true);
              setSlug(slugify(event.target.value));
            }}
            disabled={pending}
            autoComplete="off"
          />
        </Field>

        <Field
          label={t("admin.sites.hostname")}
          htmlFor="site-hostname"
          hint={t("admin.sites.hostnameHelp")}
          required
        >
          <Input
            id="site-hostname"
            value={hostnames}
            onChange={(event) => setHostnames(event.target.value)}
            // Collapse each pasted URL to its bare hostname only once they leave the
            // field — rewriting while typing a comma-separated list would fight the
            // typist, and the preview below already shows what it will become.
            onBlur={() => setHostnames(effectiveHostnames.join(", "))}
            disabled={pending}
            placeholder="z-soft.com.vn, z-soft.vn"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={hostnamesError || undefined}
          />
          {hostnamesError ? (
            <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
              {t("admin.sites.hostnameInvalid")}
            </p>
          ) : effectiveHostnames.length > 0 &&
            effectiveHostnames.join(", ") !== hostnames.trim() ? (
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              {t("admin.sites.hostnameNormalized", { hostname: effectiveHostnames.join(", ") })}
            </p>
          ) : null}
          <p className="mt-1 text-[11px] leading-4 text-amber-700 dark:text-amber-300">
            {t("admin.sites.hostnameDnsHint")}
          </p>
        </Field>

        <Field label={t("admin.sites.defaultLocale")} htmlFor="site-locale">
          <Select
            id="site-locale"
            value={defaultLocale}
            onChange={(event) => setDefaultLocale(event.target.value)}
            disabled={pending}
          >
            {locales.map((locale) => (
              <option key={locale.code} value={locale.code}>
                {locale.nativeName} ({locale.code})
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {/* The 404 that everybody hits once: the site is created, the domain is
          right, and it serves nothing — because a DRAFT site is not resolved. That
          is deliberate, so it is said here rather than discovered by browsing to
          the domain and disbelieving the result. */}
      <div className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
        <label className="flex items-start gap-2.5">
          <Checkbox
            checked={publish}
            onChange={(event) => setPublish(event.target.checked)}
            disabled={pending}
          />
          <span className="text-sm">
            <span className="font-medium">{t("admin.sites.publishNow")}</span>
            <span className="mt-0.5 block text-xs text-zinc-500 dark:text-zinc-400">
              {publish
                ? t("admin.sites.publishNowHelp", { hostname: effectiveHostnames[0] || "…" })
                : t("admin.sites.draftHelp")}
            </span>
          </span>
        </label>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}

      <Button type="submit" disabled={!ready || pending}>
        {pending ? t("admin.sites.creating") : t("admin.sites.create")}
      </Button>
    </form>
  );
}
