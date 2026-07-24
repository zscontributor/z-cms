"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/field";
import { Icon } from "@/components/shell/icon";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n-provider";
import { describePermission, sandboxDenialKeys } from "@/lib/plugin-permissions";

/**
 * The consent screen.
 *
 * Two rules shape it. First: the admin approves sentences, not scope strings —
 * `describePermission` is what makes "content:delete" mean "Delete content", and
 * a permission the admin cannot read is a permission the admin cannot refuse.
 * Second: the offered set is exactly `permissions` (what the manifest asked
 * for). Nothing else can be checked here, because the API returns 400 for a
 * grant that exceeds the manifest — and because a plugin's privileges must not
 * grow behind its manifest's back.
 *
 * Every box starts checked (the plugin was designed expecting all of them), but
 * every box can be unchecked and the install still goes through with the subset.
 *
 * `network:fetch` is the one scope whose checkbox is not self-explanatory, and it
 * gets the extra section below for it. "May reach the internet" is not a decision
 * an admin can make; "may reach api.deepl.com, and no other host" is. The hosts
 * come from the manifest, the gateway enforces exactly that list, so the sentence
 * on this screen and the rule on the server are the same sentence.
 */
export function ConsentDialog({
  open,
  onClose,
  onConfirm,
  pluginName,
  publisher,
  permissions,
  networkHosts = [],
  initialGranted,
  mode,
  pending,
  error,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (granted: string[]) => void;
  pluginName: string;
  publisher: string;
  permissions: string[];
  /** From the manifest's `network.hosts` — the only hosts the plugin can ever reach. */
  networkHosts?: string[];
  /** Already-granted set, when re-opening consent for an installed plugin. */
  initialGranted?: string[] | null;
  mode: "install" | "update";
  pending: boolean;
  error: string | null;
}) {
  const t = useT();
  const [granted, setGranted] = useState<string[]>(permissions);

  // Re-arm on every open: a dialog that reopens with the previous run's
  // half-edited selection is how an admin grants something they thought they
  // had unchecked.
  useEffect(() => {
    if (!open) return;
    setGranted(initialGranted && initialGranted.length > 0 ? [...initialGranted] : [...permissions]);
    // Deliberately keyed on `open` alone: re-running on a new array identity
    // from the parent would wipe the admin's checkbox edits mid-decision.
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (permission: string) => {
    setGranted((current) =>
      current.includes(permission)
        ? current.filter((p) => p !== permission)
        : [...current, permission],
    );
  };

  const declined = permissions.filter((p) => !granted.includes(p));
  const sensitiveGranted = granted.filter((p) => describePermission(p, t).sensitive);

  // Shown only when the scope is actually on the table AND is currently checked.
  // Unchecking the box makes the host list moot, and leaving it on screen would
  // tell the admin the plugin still reaches those hosts when it no longer can.
  const showHosts = networkHosts.length > 0 && granted.includes("network:fetch");

  return (
    <Dialog
      open={open}
      onClose={pending ? () => undefined : onClose}
      title={
        mode === "install"
          ? t("plugins.consent.installTitle", { name: pluginName })
          : t("plugins.consent.updateTitle", { name: pluginName })
      }
      description={t("plugins.consent.subtitle", { publisher })}
      className="sm:w-[42rem]"
      footer={
        <>
          <Button type="button" disabled={pending} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={pending}
            onClick={() => onConfirm(granted)}
          >
            {pending
              ? t("common.working")
              : mode === "install"
                ? t("plugins.consent.confirmInstall")
                : t("plugins.consent.confirmUpdate")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? (
          <p
            role="alert"
            className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
          >
            {error}
          </p>
        ) : null}

        <section>
          <h3 className="text-xs font-semibold">{t("plugins.consent.requestsHeading")}</h3>
          <p className="mt-0.5 text-[11px] z-muted">{t("plugins.consent.requestsHint")}</p>

          {permissions.length === 0 ? (
            <p className="mt-3 rounded-md border border-[var(--border)] bg-[var(--surface-sunken)] px-3 py-2 text-xs z-muted">
              {t("plugins.consent.requestsNone")}
            </p>
          ) : (
            <ul className="mt-2.5 flex flex-col gap-1.5">
              {permissions.map((permission) => {
                const copy = describePermission(permission, t);
                const checked = granted.includes(permission);
                const id = `consent-${permission.replace(/[^a-z0-9]+/gi, "-")}`;

                return (
                  <li key={permission}>
                    <label
                      htmlFor={id}
                      className={cn(
                        "flex cursor-pointer gap-2.5 rounded-md border p-2.5 transition-colors",
                        copy.sensitive
                          ? "border-amber-200 bg-amber-50/70 hover:bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30 dark:hover:bg-amber-950/50"
                          : "border-[var(--border)] bg-[var(--surface-raised)] hover:bg-[var(--surface-sunken)]",
                        !checked && "opacity-60",
                      )}
                    >
                      <Checkbox
                        id={id}
                        className="mt-0.5 shrink-0"
                        checked={checked}
                        disabled={pending}
                        onChange={() => toggle(permission)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="text-xs font-medium">{copy.label}</span>
                          {copy.sensitive ? (
                            <Badge tone="warning">{t("plugins.consent.sensitive")}</Badge>
                          ) : null}
                        </span>
                        <span className="mt-0.5 block text-[11px] leading-4 z-muted">
                          {copy.detail}
                        </span>
                        <code className="mt-1 block font-mono text-[10px] z-muted">
                          {permission}
                        </code>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {showHosts ? (
          <section className="rounded-md border border-amber-200 bg-amber-50/70 p-3 dark:border-amber-900 dark:bg-amber-950/30">
            <h3 className="text-xs font-semibold text-amber-900 dark:text-amber-300">
              {t("plugins.consent.networkHeading")}
            </h3>
            <p className="mt-0.5 text-[11px] text-amber-800/80 dark:text-amber-400/80">
              {t("plugins.consent.networkHint")}
            </p>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {networkHosts.map((host) => (
                <li
                  key={host}
                  className="rounded border border-amber-300 bg-amber-100/70 px-1.5 py-0.5 font-mono text-[11px] text-amber-900 dark:border-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
                >
                  {host}
                </li>
              ))}
              <li className="px-1 py-0.5 text-[11px] italic text-amber-800/80 dark:text-amber-400/80">
                {t("plugins.consent.networkOnlyThese")}
              </li>
            </ul>
          </section>
        ) : null}

        <section className="rounded-md border border-emerald-200 bg-emerald-50/70 p-3 dark:border-emerald-900 dark:bg-emerald-950/30">
          <h3 className="text-xs font-semibold text-emerald-800 dark:text-emerald-300">
            {t("plugins.consent.deniedHeading")}
          </h3>
          <p className="mt-0.5 text-[11px] text-emerald-800/80 dark:text-emerald-400/80">
            {t("plugins.consent.deniedHint")}
          </p>
          <ul className="mt-2 grid gap-1 sm:grid-cols-2">
            {sandboxDenialKeys(showHosts ? networkHosts : []).map((key) => (
              <li
                key={key}
                className="flex items-start gap-1.5 text-[11px] leading-4 text-emerald-900 dark:text-emerald-300"
              >
                <Icon name="check" size={18} className="mt-0.5 shrink-0" />
                <span>{t(key)}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-md border border-[var(--border)] bg-[var(--surface-sunken)] p-3">
          <h3 className="text-xs font-semibold">{t("plugins.consent.summaryHeading")}</h3>
          {granted.length === 0 ? (
            <p className="mt-1 text-[11px] z-muted">{t("plugins.consent.summaryNone")}</p>
          ) : (
            <ul className="mt-1.5 flex flex-col gap-1">
              {granted.map((permission) => {
                const copy = describePermission(permission, t);
                return (
                  <li key={permission} className="flex items-start gap-1.5 text-[11px] leading-4">
                    <Icon
                      name="check"
                      size={16}
                      className={cn(
                        "mt-0.5 shrink-0",
                        copy.sensitive ? "text-amber-600 dark:text-amber-400" : "text-brand-500",
                      )}
                    />
                    <span>{copy.label}</span>
                  </li>
                );
              })}
            </ul>
          )}

          {sensitiveGranted.length > 0 ? (
            <p className="mt-2 text-[11px] leading-4 text-amber-700 dark:text-amber-400">
              {t("plugins.consent.summarySensitive", {
                count: sensitiveGranted.length,
                publisher,
              })}
            </p>
          ) : null}

          {declined.length > 0 ? (
            <p className="mt-2 text-[11px] leading-4 z-muted">
              {t("plugins.consent.summaryDeclined", {
                count: declined.length,
                list: declined.map((p) => describePermission(p, t).label).join(", "),
              })}
            </p>
          ) : null}
        </section>
      </div>
    </Dialog>
  );
}
