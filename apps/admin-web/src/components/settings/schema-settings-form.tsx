"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/field";
import { MediaPickerField } from "@/components/editor/media-picker";
import { useT } from "@/lib/i18n-provider";
import {
  normalizeThemeSchema,
  resolveThemeValues,
  type ThemeSettingControl,
  type ThemeSettingsSchema,
} from "@/lib/theme-schema";

/**
 * JSON-driven settings form: every control is derived from the extension's own
 * settingsSchema, so neither a theme nor a plugin needs a line of admin code to
 * add a setting. Themes and plugins render the same widgets because it is the
 * same component — only the save action differs.
 */
export function SchemaSettingsForm({
  idPrefix,
  schema,
  settings,
  disabled,
  onSave,
  emptyText,
  deniedText,
}: {
  /** Namespaces the input ids so two forms on one page cannot collide. */
  idPrefix: string;
  schema: ThemeSettingsSchema | null;
  settings: Record<string, unknown>;
  disabled?: boolean;
  onSave: (values: Record<string, unknown>) => Promise<{ ok: true; message: string } | { ok: false; error: string }>;
  emptyText: string;
  /** Shown when `disabled` because the user lacks the configure permission. */
  deniedText?: string;
}) {
  const t = useT();
  const controls = normalizeThemeSchema(schema);
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    resolveThemeValues(controls, settings),
  );
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  if (controls.length === 0) {
    return <p className="text-xs z-muted">{emptyText}</p>;
  }

  function set(key: string, value: unknown) {
    setValues((current) => ({ ...current, [key]: value }));
    setMessage(null);
  }

  function submit() {
    startTransition(async () => {
      const result = await onSave(values);
      setMessage(
        result.ok ? { ok: true, text: result.message } : { ok: false, text: result.error },
      );
    });
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="flex flex-col gap-4"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {controls.map((control) => (
          <Control
            key={control.key}
            idPrefix={idPrefix}
            control={control}
            value={values[control.key]}
            disabled={disabled || pending}
            onChange={(value) => set(control.key, value)}
          />
        ))}
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={disabled || pending}>
          {pending ? t("common.saving") : t("common.saveSettings")}
        </Button>
        <Button
          type="button"
          disabled={disabled || pending}
          onClick={() => {
            setValues(resolveThemeValues(controls, {}));
            setMessage(null);
          }}
        >
          {t("common.restoreDefaults")}
        </Button>
        {message ? (
          <span
            role="status"
            className={
              message.ok
                ? "text-[11px] text-emerald-600 dark:text-emerald-400"
                : "text-[11px] text-red-600 dark:text-red-400"
            }
          >
            {message.text}
          </span>
        ) : null}
      </div>

      {disabled && deniedText ? <p className="text-[11px] z-muted">{deniedText}</p> : null}
    </form>
  );
}

function Control({
  idPrefix,
  control,
  value,
  onChange,
  disabled,
}: {
  idPrefix: string;
  control: ThemeSettingControl;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const id = `${idPrefix}-${control.key}`;
  const wide = control.kind === "textarea" || control.kind === "image";

  return (
    <Field
      label={control.label}
      hint={control.description}
      htmlFor={id}
      required={control.required}
      className={wide ? "sm:col-span-2" : undefined}
    >
      {control.kind === "color" ? (
        <div className="flex gap-2">
          <input
            id={id}
            type="color"
            disabled={disabled}
            value={typeof value === "string" && value ? value : "#000000"}
            onChange={(event) => onChange(event.target.value)}
            className="h-9 w-12 shrink-0 cursor-pointer rounded-md border border-[var(--border-strong)] bg-[var(--surface-raised)] p-1"
          />
          <Input
            disabled={disabled}
            value={asString(value)}
            onChange={(event) => onChange(event.target.value)}
            placeholder="#FA5600"
            className="font-mono text-xs"
          />
        </div>
      ) : null}

      {control.kind === "boolean" ? (
        <label className="flex h-9 items-center gap-2 text-sm">
          <Checkbox
            id={id}
            disabled={disabled}
            checked={value === true}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span className="z-muted">{value === true ? t("common.on") : t("common.off")}</span>
        </label>
      ) : null}

      {control.kind === "number" ? (
        <Input
          id={id}
          type="number"
          disabled={disabled}
          min={control.min}
          max={control.max}
          value={value === undefined || value === null ? "" : String(value)}
          onChange={(event) => {
            const raw = event.target.value;
            onChange(raw === "" ? undefined : Number(raw));
          }}
        />
      ) : null}

      {control.kind === "textarea" ? (
        <Textarea
          id={id}
          rows={4}
          disabled={disabled}
          value={asString(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : null}

      {control.kind === "enum" ? (
        <Select
          id={id}
          disabled={disabled}
          value={asString(value)}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">{t("common.selectPlaceholder")}</option>
          {control.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      ) : null}

      {control.kind === "image" ? (
        <MediaPickerField
          id={id}
          mode="url"
          value={asString(value)}
          onChange={(next) => onChange(next)}
        />
      ) : null}

      {control.kind === "url" || control.kind === "text" || control.kind === "password" ? (
        <Input
          id={id}
          type={control.kind === "url" ? "url" : control.kind === "password" ? "password" : "text"}
          disabled={disabled}
          value={asString(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : null}
    </Field>
  );
}

function asString(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : String(value);
}
