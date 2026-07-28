"use client";

import { Badge } from "@/components/ui/badge";
import { ChangelogNote } from "@/components/changelog-note";
import { Icon } from "@/components/shell/icon";
import type { CatalogPluginDto } from "@/lib/api";
import { useT } from "@/lib/i18n-provider";
import { describePermission } from "@/lib/plugin-permissions";

/**
 * The read-only body of a plugin — description, changelog, what it offers themes,
 * and the permissions it was granted. Shared verbatim by the catalogue card and
 * the detail drawer so the two can never drift; `descriptionClamp` is the only
 * thing that differs (a card truncates, a drawer has room to breathe).
 */
export function PluginInfo({
  plugin,
  granted,
  descriptionClamp = false,
}: {
  plugin: CatalogPluginDto;
  /** The permissions actually granted, or null when the API did not say. */
  granted: string[] | null;
  descriptionClamp?: boolean;
}) {
  const t = useT();

  return (
    <>
      <p
        className={
          descriptionClamp
            ? "mt-2 line-clamp-3 min-h-8 text-xs z-muted"
            : "mt-2 text-xs leading-5 z-muted"
        }
      >
        {plugin.description ?? t("plugins.card.noDescription")}
      </p>

      <ChangelogNote
        label={t("plugins.card.changelog", { version: plugin.latestVersion ?? "—" })}
        changelog={plugin.changelog}
      />

      {plugin.capabilities.length > 0 ? (
        <div className="mt-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider z-muted">
            {t("plugins.card.capabilities")}
          </p>
          <ul className="mt-1 flex flex-wrap gap-1">
            {plugin.capabilities.map((capability) => (
              <li key={capability}>
                <Badge tone="neutral" className="font-mono">
                  {capability}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {plugin.installed ? (
        <div className="mt-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider z-muted">
            {t("plugins.card.grantedHeading")}
          </p>
          {granted === null ? (
            <p className="mt-1 text-[11px] z-muted">{t("plugins.card.grantedUnknown")}</p>
          ) : granted.length === 0 ? (
            <p className="mt-1 text-[11px] z-muted">{t("plugins.card.grantedNone")}</p>
          ) : (
            <ul className="mt-1 flex flex-col gap-0.5">
              {granted.map((permission) => {
                const copy = describePermission(permission, t);
                return (
                  <li key={permission} className="flex items-start gap-1.5 text-[11px] leading-4">
                    <Icon
                      name="check"
                      size={16}
                      className={
                        copy.sensitive
                          ? "mt-0.5 shrink-0 text-amber-600 dark:text-amber-400"
                          : "mt-0.5 shrink-0 text-brand-500"
                      }
                    />
                    <span>{copy.label}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : plugin.permissions.length > 0 ? (
        <p className="mt-3 text-[11px] z-muted">
          {t("plugins.card.requests", { count: plugin.permissions.length })}
        </p>
      ) : (
        <p className="mt-3 text-[11px] z-muted">{t("plugins.card.requestsNone")}</p>
      )}
    </>
  );
}
