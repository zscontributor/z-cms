"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { LocaleInfo } from "@zcmsorg/i18n";
import type { LocalizedText, SiteClosureMode, SiteDto, SiteMaintenance } from "@zcmsorg/schemas";
import { updateSiteAction } from "@/app/actions/site";
import { MediaPickerField } from "@/components/editor/media-picker";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n-provider";

/**
 * `<input type="datetime-local">` speaks local wall-clock `YYYY-MM-DDTHH:mm` and
 * nothing else; the API stores an instant. These two convert, both ways.
 */
function toDateTimeLocal(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function fromDateTimeLocal(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Days/hours/minutes/seconds until `iso`, for the preview; null without a date. */
function countdownParts(iso: string | null): [number, number, number, number] | null {
  if (!iso) return null;
  const left = Math.max(0, Math.floor((Date.parse(iso) - Date.now()) / 1000));
  return [
    Math.floor(left / 86400),
    Math.floor((left % 86400) / 3600),
    Math.floor((left % 3600) / 60),
    left % 60,
  ];
}

/** A URL-safe secret the owner never has to type. */
function generateKey(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The site's front door, for the bypass and preview links. */
function siteOrigin(site: SiteDto): string {
  const primary = site.domains.find((d) => d.isPrimary) ?? site.domains[0];
  if (!primary) return "";
  const scheme = primary.hostname.startsWith("localhost") ? "http" : "https";
  return `${scheme}://${primary.hostname}`;
}

function withoutEmpty(text: LocalizedText): LocalizedText {
  const out: LocalizedText = {};
  for (const [locale, value] of Object.entries(text)) {
    if (value.trim()) out[locale] = value.trim();
  }
  return out;
}

/**
 * Maintenance mode for one site.
 *
 * Closing a site is a switch, and the switch is deliberately in the same form as
 * the notice it shows: an owner who flips it without writing anything gets the
 * platform's wording, in the visitor's language, over the site's own logo — a
 * notice, not a blank page. Everything else here is what the visitor sees while
 * the site is closed, and the preview beneath the form draws exactly that with
 * the values as typed, so the owner sees it before any visitor does.
 *
 * The bypass key is the way back in: the link it makes sets a cookie that lets
 * that browser through, so the owner can check the real site (or fix the theme
 * that is the reason for the closure) while everyone else sees the notice.
 */
export function SiteMaintenanceForm({
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

  const initial = site.maintenance;
  const [enabled, setEnabled] = useState(initial.enabled);
  const [mode, setMode] = useState<SiteClosureMode>(initial.mode);
  const [title, setTitle] = useState<LocalizedText>(initial.title);
  const [message, setMessage] = useState<LocalizedText>(initial.message);
  const [logo, setLogo] = useState(initial.logo);
  const [backgroundImage, setBackgroundImage] = useState(initial.backgroundImage);
  const [backgroundColor, setBackgroundColor] = useState(initial.backgroundColor);
  const [textColor, setTextColor] = useState(initial.textColor);
  const [expectedBackAt, setExpectedBackAt] = useState(toDateTimeLocal(initial.expectedBackAt));
  const [bypassKey, setBypassKey] = useState(initial.bypassKey);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  // The languages this site publishes in, in the platform's order, default first —
  // the notice falls back to the default locale's text, so that is the tab that
  // matters most and the one the owner lands on.
  const siteLocales = useMemo(() => {
    const known = locales.filter((l) => site.locales.includes(l.code));
    const unknown = site.locales
      .filter((code) => !known.some((l) => l.code === code))
      .map((code) => ({ code, nativeName: code }) as LocaleInfo);
    return [...known, ...unknown].sort((a, b) =>
      a.code === site.defaultLocale ? -1 : b.code === site.defaultLocale ? 1 : 0,
    );
  }, [locales, site.locales, site.defaultLocale]);
  const [activeLocale, setActiveLocale] = useState(site.defaultLocale);

  const origin = siteOrigin(site);
  const hexValid = (value: string) => /^#[0-9a-fA-F]{6}$/.test(value);
  const colorsValid = hexValid(backgroundColor) && hexValid(textColor);
  const keyValid = bypassKey === "" || /^[A-Za-z0-9_-]{8,128}$/.test(bypassKey);
  const disabled = !canUpdate || pending;

  function save(next: Partial<SiteMaintenance> = {}) {
    setResult(null);
    const maintenance: SiteMaintenance = {
      enabled,
      mode,
      title: withoutEmpty(title),
      message: withoutEmpty(message),
      logo: logo.trim(),
      backgroundImage: backgroundImage.trim(),
      backgroundColor,
      textColor,
      expectedBackAt: fromDateTimeLocal(expectedBackAt),
      bypassKey,
      ...next,
    };
    startTransition(async () => {
      const res = await updateSiteAction(site.id, { maintenance });
      setResult(
        res.ok
          ? {
              ok: true,
              message: !maintenance.enabled
                ? t("admin.sites.maintenance.savedOff")
                : maintenance.mode === "coming-soon"
                  ? t("admin.sites.maintenance.savedComingSoon")
                  : t("admin.sites.maintenance.savedOn"),
            }
          : { ok: false, message: res.error },
      );
      if (res.ok) router.refresh();
    });
  }

  // What the visitor will see, drawn from the values as typed — the same rules
  // site-runtime applies (owner's text, else the platform's; owner's logo, else
  // the brand's; the colour tinting the image), in miniature.
  const comingSoon = mode === "coming-soon";
  // Copy keyed by mode: "admin.sites.maintenance.defaultTitle" vs
  // "…defaultTitleComingSoon", and likewise for the labels below.
  const m = (key: string) => t(`admin.sites.maintenance.${key}${comingSoon ? "ComingSoon" : ""}`);
  const previewTitle =
    title[activeLocale]?.trim() || title[site.defaultLocale]?.trim() || m("defaultTitle");
  const previewMessage =
    message[activeLocale]?.trim() || message[site.defaultLocale]?.trim() || m("defaultMessage");
  const previewCountdown = comingSoon ? countdownParts(fromDateTimeLocal(expectedBackAt)) : null;
  const previewLogo = logo.trim() || site.brand.logo;
  const previewBg = hexValid(backgroundColor) ? backgroundColor : "#0F172A";
  const previewFg = hexValid(textColor) ? textColor : "#FFFFFF";

  return (
    <form
      className="z-card space-y-6 p-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled || !colorsValid || !keyValid) return;
        save();
      }}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold">{t("admin.sites.maintenance.title")}</h2>
          <p className="mt-0.5 max-w-2xl text-[11px] leading-4 z-muted">
            {t("admin.sites.maintenance.help")}
          </p>
        </div>

        {/* The switch. Saved on its own, immediately: "close the site" is not a
            thing to leave sitting in an unsaved form. */}
        <div className="flex items-center gap-3 text-sm">
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-xs font-medium",
              enabled
                ? "bg-amber-500/15 text-amber-800 dark:text-amber-200"
                : "bg-[var(--surface-sunken)] z-muted",
            )}
          >
            {!enabled
              ? t("admin.sites.maintenance.off")
              : comingSoon
                ? t("admin.sites.maintenance.onComingSoon")
                : t("admin.sites.maintenance.on")}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label={t("admin.sites.maintenance.toggle")}
            disabled={disabled}
            onClick={() => {
              // The switch saves the whole form with it — the notice as typed is
              // what goes live — so it refuses while a colour or key is malformed.
              if (!colorsValid || !keyValid) {
                setResult({ ok: false, message: t("admin.sites.maintenance.fixBeforeToggle") });
                return;
              }
              const next = !enabled;
              setEnabled(next);
              save({ enabled: next });
            }}
            className={cn(
              "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-transparent transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40",
              "disabled:cursor-not-allowed disabled:opacity-50",
              enabled ? "bg-amber-500" : "bg-[var(--border-strong)]",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "inline-block size-5 rounded-full bg-white shadow transition-transform",
                enabled ? "translate-x-5" : "translate-x-0.5",
              )}
            />
          </button>
        </div>
      </div>

      {enabled ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
          {m("activeNotice")}
        </div>
      ) : null}

      {/* Which page: an outage (503, crawlers wait) or a launch page (200, a
          countdown). Same notice, same form — the difference is what the world
          is told about it. */}
      <fieldset>
        <legend className="mb-2 text-xs font-semibold uppercase tracking-wider z-muted">
          {t("admin.sites.maintenance.mode")}
        </legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {(
            [
              ["maintenance", "modeMaintenance", "modeMaintenanceHelp"],
              ["coming-soon", "modeComingSoon", "modeComingSoonHelp"],
            ] as const
          ).map(([value, labelKey, helpKey]) => (
            <label
              key={value}
              className={cn(
                "flex cursor-pointer gap-3 rounded-lg border p-3 text-sm transition-colors",
                mode === value
                  ? "border-brand-500 bg-brand-500/5"
                  : "border-[var(--border)] hover:bg-[var(--surface-sunken)]",
                disabled && "cursor-not-allowed opacity-60",
              )}
            >
              <input
                type="radio"
                name="maintenance-mode"
                value={value}
                checked={mode === value}
                onChange={() => setMode(value)}
                disabled={disabled}
                className="mt-0.5 accent-brand-500"
              />
              <span>
                <span className="block font-medium">{t(`admin.sites.maintenance.${labelKey}`)}</span>
                <span className="mt-0.5 block text-[11px] leading-4 z-muted">
                  {t(`admin.sites.maintenance.${helpKey}`)}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {/* The notice, per language. */}
      <div>
        <div className="mb-3 flex flex-wrap items-center gap-1 border-b border-[var(--border)]">
          {siteLocales.map((locale) => {
            const filled = Boolean(title[locale.code]?.trim() || message[locale.code]?.trim());
            return (
              <button
                key={locale.code}
                type="button"
                onClick={() => setActiveLocale(locale.code)}
                className={cn(
                  "-mb-px border-b-2 px-3 py-2 text-xs font-medium transition-colors",
                  activeLocale === locale.code
                    ? "border-brand-500 text-[var(--text)]"
                    : "border-transparent z-muted hover:text-[var(--text)]",
                )}
              >
                {locale.nativeName}
                {locale.code === site.defaultLocale ? (
                  <span className="ml-1 text-[10px] uppercase z-muted">
                    {t("admin.sites.maintenance.defaultLocaleTag")}
                  </span>
                ) : null}
                {filled ? <span className="ml-1 text-brand-500">•</span> : null}
              </button>
            );
          })}
        </div>

        <div className="grid gap-4">
          <Field
            label={t("admin.sites.maintenance.heading")}
            htmlFor={`maintenance-title-${activeLocale}`}
            hint={t("admin.sites.maintenance.headingHelp")}
          >
            <Input
              id={`maintenance-title-${activeLocale}`}
              value={title[activeLocale] ?? ""}
              onChange={(event) =>
                setTitle((prev) => ({ ...prev, [activeLocale]: event.target.value }))
              }
              placeholder={m("defaultTitle")}
              maxLength={200}
              disabled={disabled}
            />
          </Field>

          <Field
            label={t("admin.sites.maintenance.message")}
            htmlFor={`maintenance-message-${activeLocale}`}
            hint={t("admin.sites.maintenance.messageHelp")}
          >
            <Textarea
              id={`maintenance-message-${activeLocale}`}
              value={message[activeLocale] ?? ""}
              onChange={(event) =>
                setMessage((prev) => ({ ...prev, [activeLocale]: event.target.value }))
              }
              placeholder={m("defaultMessage")}
              rows={4}
              maxLength={4000}
              disabled={disabled}
            />
          </Field>
        </div>
      </div>

      {/* Appearance. */}
      <div className="border-t border-[var(--border)] pt-5">
        <h3 className="text-xs font-semibold uppercase tracking-wider z-muted">
          {t("admin.sites.maintenance.appearance")}
        </h3>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field
            label={t("admin.sites.maintenance.logo")}
            htmlFor="maintenance-logo"
            hint={t("admin.sites.maintenance.logoHelp")}
          >
            <MediaPickerField id="maintenance-logo" value={logo} onChange={setLogo} mode="url" />
          </Field>

          <Field
            label={t("admin.sites.maintenance.background")}
            htmlFor="maintenance-background"
            hint={t("admin.sites.maintenance.backgroundHelp")}
          >
            <MediaPickerField
              id="maintenance-background"
              value={backgroundImage}
              onChange={setBackgroundImage}
              mode="url"
            />
          </Field>

          <ColorField
            id="maintenance-bg-color"
            label={t("admin.sites.maintenance.backgroundColor")}
            value={backgroundColor}
            onChange={setBackgroundColor}
            disabled={disabled}
            invalid={!hexValid(backgroundColor)}
          />

          <ColorField
            id="maintenance-text-color"
            label={t("admin.sites.maintenance.textColor")}
            value={textColor}
            onChange={setTextColor}
            disabled={disabled}
            invalid={!hexValid(textColor)}
          />

          <Field
            label={m("expectedBackAt")}
            htmlFor="maintenance-eta"
            hint={m("expectedBackAtHelp")}
          >
            <Input
              id="maintenance-eta"
              type="datetime-local"
              value={expectedBackAt}
              onChange={(event) => setExpectedBackAt(event.target.value)}
              disabled={disabled}
            />
          </Field>
        </div>
      </div>

      {/* The preview: the values as typed, in miniature. */}
      <div>
        <p className="mb-1.5 text-[11px] uppercase tracking-wider z-muted">
          {t("admin.sites.maintenance.preview")}
        </p>
        <div
          aria-hidden
          className="flex min-h-56 items-center justify-center overflow-hidden rounded-lg border border-[var(--border)] px-6 py-10 text-center"
          style={{
            backgroundColor: previewBg,
            color: previewFg,
            backgroundImage: backgroundImage.trim()
              ? `linear-gradient(${previewBg}b8, ${previewBg}b8), url("${backgroundImage.trim().replace(/"/g, "")}")`
              : undefined,
            backgroundSize: "cover",
            backgroundPosition: "center",
          }}
        >
          <div className="max-w-md">
            {previewLogo ? (
              <img src={previewLogo} alt="" className="mx-auto mb-4 max-h-10 max-w-40 object-contain" />
            ) : (
              <div
                className="mx-auto mb-4 h-1 w-10 rounded-full"
                style={{ background: site.brand.primaryColor }}
              />
            )}
            <p className="text-xl font-extrabold leading-tight">{previewTitle}</p>
            <p className="mt-2 whitespace-pre-line text-sm opacity-85">{previewMessage}</p>
            {previewCountdown ? (
              <div className="mt-4 flex justify-center gap-2 tabular-nums">
                {previewCountdown.map((value, i) => (
                  <span
                    key={i}
                    className="min-w-12 rounded-md border border-white/20 bg-white/10 px-2 py-1.5"
                  >
                    <span className="block text-base font-extrabold leading-none">
                      {i === 0 ? value : String(value).padStart(2, "0")}
                    </span>
                    <span className="mt-1 block text-[9px] uppercase tracking-wider opacity-70">
                      {t(`admin.sites.maintenance.units.${i}`)}
                    </span>
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* Bypass and preview links. */}
      <div className="border-t border-[var(--border)] pt-5">
        <h3 className="text-xs font-semibold uppercase tracking-wider z-muted">
          {t("admin.sites.maintenance.bypass")}
        </h3>
        <p className="mt-1 max-w-2xl text-[11px] leading-4 z-muted">
          {t("admin.sites.maintenance.bypassHelp")}
        </p>

        <div className="mt-3 flex flex-wrap items-end gap-2">
          <Field
            label={t("admin.sites.maintenance.bypassKey")}
            htmlFor="maintenance-bypass"
            className="min-w-64 flex-1"
          >
            <Input
              id="maintenance-bypass"
              value={bypassKey}
              onChange={(event) => setBypassKey(event.target.value.trim())}
              disabled={disabled}
              spellCheck={false}
              autoComplete="off"
              className="font-mono"
              aria-invalid={!keyValid || undefined}
            />
          </Field>
          <Button
            type="button"
            variant="secondary"
            disabled={disabled}
            onClick={() => setBypassKey(generateKey())}
          >
            {t("admin.sites.maintenance.generateKey")}
          </Button>
          {bypassKey ? (
            <Button
              type="button"
              variant="ghost"
              disabled={disabled}
              onClick={() => setBypassKey("")}
            >
              {t("admin.sites.maintenance.clearKey")}
            </Button>
          ) : null}
        </div>
        {!keyValid ? (
          <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
            {t("admin.sites.maintenance.bypassKeyInvalid")}
          </p>
        ) : null}

        {initial.bypassKey && origin ? (
          <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-[auto_1fr] sm:gap-x-4">
            <dt className="z-muted">{t("admin.sites.maintenance.bypassLink")}</dt>
            <dd className="break-all font-mono">
              <a
                href={`${origin}/?zc-bypass=${encodeURIComponent(initial.bypassKey)}`}
                target="_blank"
                rel="noreferrer"
                className="hover:underline"
              >
                {origin}/?zc-bypass={initial.bypassKey}
              </a>
            </dd>
            <dt className="z-muted">{t("admin.sites.maintenance.previewLink")}</dt>
            <dd className="break-all font-mono">
              <a
                href={`${origin}/?zc-maintenance-preview=${encodeURIComponent(initial.bypassKey)}`}
                target="_blank"
                rel="noreferrer"
                className="hover:underline"
              >
                {origin}/?zc-maintenance-preview={initial.bypassKey}
              </a>
            </dd>
          </dl>
        ) : (
          <p className="mt-2 text-[11px] leading-4 z-muted">
            {t("admin.sites.maintenance.linksAfterSave")}
          </p>
        )}
        {bypassKey !== initial.bypassKey ? (
          <p className="mt-2 text-[11px] leading-4 text-amber-700 dark:text-amber-300">
            {t("admin.sites.maintenance.keyUnsaved")}
          </p>
        ) : null}
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
        <Button type="submit" disabled={disabled || !colorsValid || !keyValid}>
          {pending ? t("admin.sites.saving") : t("admin.sites.save")}
        </Button>
        <p className="text-[11px] z-muted">{t("admin.sites.maintenance.propagation")}</p>
      </div>
    </form>
  );
}

/** A colour: the native picker beside its hex, editable as text like the brand colour. */
function ColorField({
  id,
  label,
  value,
  onChange,
  disabled,
  invalid,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  invalid: boolean;
}) {
  const valid = /^#[0-9a-fA-F]{6}$/.test(value);
  return (
    <Field label={label} htmlFor={id}>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="color"
          value={valid ? value : "#000000"}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          className="h-9 w-12 shrink-0 cursor-pointer rounded-md border border-[var(--border-strong)] bg-transparent p-1"
        />
        <Input
          aria-label={label}
          value={value}
          onChange={(event) => {
            const next = event.target.value.trim();
            onChange(next.startsWith("#") ? next : `#${next}`);
          }}
          disabled={disabled}
          spellCheck={false}
          className="font-mono"
          aria-invalid={invalid || undefined}
        />
      </div>
    </Field>
  );
}
