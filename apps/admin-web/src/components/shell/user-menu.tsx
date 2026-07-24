"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { SWITCHER_LOCALES } from "@zcmsorg/i18n/client";
import type { SessionUser } from "@zcmsorg/schemas";
import { logoutAction } from "@/app/actions/auth";
import { setLocaleAction } from "@/app/actions/locale";
import { SubmitButton } from "@/components/ui/submit-button";
import { useLocale, useT } from "@/lib/i18n-provider";
import { cn } from "@/lib/cn";
import { Flag } from "./flag";
import { Icon } from "./icon";

export function UserMenu({ user }: { user: SessionUser }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocument(event: MouseEvent) {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocument);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocument);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const initials = user.name
    .split(" ")
    .filter(Boolean)
    .slice(-2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-[var(--surface-sunken)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
      >
        {user.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={user.avatarUrl}
            alt=""
            className="size-7 rounded-full object-cover"
            width={28}
            height={28}
          />
        ) : (
          <span className="flex size-7 items-center justify-center rounded-full bg-brand-500/15 text-[11px] font-semibold text-brand-600 dark:text-brand-300">
            {initials || "?"}
          </span>
        )}
        <span className="hidden text-xs font-medium sm:block">{user.name}</span>
        <Icon name="down" size={18} className="z-muted" />
      </button>

      {open ? (
        <div
          role="menu"
          className="z-card absolute right-0 mt-1.5 w-60 overflow-hidden p-0 shadow-lg"
        >
          <div className="border-b border-[var(--border)] px-3 py-2.5">
            <p className="truncate text-xs font-medium">{user.name}</p>
            <p className="truncate text-[11px] z-muted">{user.email}</p>
            <p className="mt-1 text-[11px] z-muted">
              {t(`admin.roles.${user.role}`)} · {user.tenantSlug}
            </p>
          </div>

          {/* Not in the sidebar: your own account is not one of the site's
              sections, and it is the one screen every role can reach. */}
          <div className="border-b border-[var(--border)] p-1.5">
            <Link
              href="/profile"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-[var(--surface-sunken)]"
            >
              <Icon name="profile" size={18} />
              {t("admin.profile.nav")}
            </Link>
          </div>

          <LanguageSwitcher />

          <form action={logoutAction} className="p-1.5">
            <SubmitButton
              variant="ghost"
              size="sm"
              className="w-full justify-start"
              pendingLabel={t("auth.signingOut")}
            >
              <Icon name="logout" size={18} />
              {t("auth.signOut")}
            </SubmitButton>
          </form>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Lives in the user menu because the language is a property of the person, not of
 * the site: switching site must not switch language, and the two controls being
 * next to each other in the topbar would suggest otherwise.
 *
 * The action writes the cookie; `refresh()` is what re-renders the server half of
 * the shell (sidebar, page headers) in the new language — without it, only the
 * client components would change and the page would be half-translated.
 */
function LanguageSwitcher() {
  const t = useT();
  const router = useRouter();
  const current = useLocale();
  const [pending, startTransition] = useTransition();

  return (
    <div className="border-b border-[var(--border)] p-1.5">
      <p className="flex items-center gap-1.5 px-1.5 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wider z-muted">
        <Icon name="language" size={16} />
        {t("admin.language.label")}
      </p>
      {SWITCHER_LOCALES.map((locale) => {
        const active = locale.code === current;
        return (
          <button
            key={locale.code}
            type="button"
            role="menuitemradio"
            aria-checked={active}
            disabled={pending || active}
            onClick={() =>
              startTransition(async () => {
                await setLocaleAction(locale.code);
                router.refresh();
              })
            }
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
              active
                ? "font-medium text-brand-600 dark:text-brand-300"
                : "hover:bg-[var(--surface-sunken)] disabled:opacity-60",
            )}
          >
            <Flag locale={locale.code} flag={locale.flag} />
            <span className="min-w-0 flex-1 truncate">{locale.nativeName}</span>
            {active ? <Icon name="check" size={18} className="shrink-0" /> : null}
          </button>
        );
      })}
    </div>
  );
}
