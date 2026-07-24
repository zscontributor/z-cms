"use client";

import { saveThemeSettingsAction } from "@/app/actions/theme";
import { SchemaSettingsForm } from "@/components/settings/schema-settings-form";
import { useT } from "@/lib/i18n-provider";
import type { ThemeSettingsSchema } from "@/lib/theme-schema";

/**
 * JSON-driven: every control is derived from the theme's own settingsSchema.
 * There is no theme-specific code in admin-web, and a theme that adds a setting
 * needs no admin release. The form itself is shared with the plugin settings
 * screen — see components/settings/schema-settings-form.
 */
export function ThemeSettingsForm({
  themeKey,
  schema,
  settings,
  disabled,
}: {
  themeKey: string;
  schema: ThemeSettingsSchema | null;
  settings: Record<string, unknown>;
  disabled?: boolean;
}) {
  const t = useT();

  return (
    <SchemaSettingsForm
      idPrefix={`theme-${themeKey}`}
      schema={schema}
      settings={settings}
      disabled={disabled}
      onSave={(values) => saveThemeSettingsAction(themeKey, values)}
      emptyText={t("appearance.settings.empty")}
      deniedText={t("appearance.settings.denied")}
    />
  );
}
