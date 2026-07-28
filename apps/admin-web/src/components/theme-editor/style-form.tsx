"use client";

import {
  NODE_STYLE_FIELDS,
  type NodeStyle,
  type NodeStyleFieldSpec,
  type NodeStyleGroup,
} from "@zcmsorg/schemas";
import { useState } from "react";
import { Field, Input, Select } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { MediaPickerField, MediaPickerDialog } from "@/components/editor/media-picker";
import { useT } from "@/lib/i18n-provider";
import { ColorPicker } from "./color-picker";

/**
 * The Style tab of the Inspector — the "design drawer".
 *
 * Renders NODE_STYLE_FIELDS (from @zcmsorg/schemas) as a control per bounded knob,
 * grouped for the panel. It is the visual twin of WidgetPropsForm: the same
 * every-keystroke write cadence, because the canvas beside it shows the result live.
 * The list is the description — a field the widget library does not read is a field
 * this file never draws, because it isn't in NODE_STYLE_FIELDS.
 *
 * `style` applies to ANY node kind (section, row, column, widget), so unlike the
 * per-widget props form there is no per-type catalogue: one universal surface.
 */

const GROUP_ORDER: readonly NodeStyleGroup[] = [
  "size",
  "colors",
  "spacing",
  "border",
  "shadow",
  "typography",
  "transform",
  "filter",
  "effectShadow",
  "hover",
];

export function StyleForm({
  style,
  onChange,
  disabled,
}: {
  style: NodeStyle | undefined;
  onChange: (style: NodeStyle) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const current = style ?? {};

  // Setting a value to undefined DROPS the key: an empty style object is no style,
  // and layout-doc.setStyle removes the whole `style` when nothing is left, keeping
  // the in-memory tree equal to what the server stores.
  const set = (key: keyof NodeStyle, value: string | number | undefined) => {
    const next: NodeStyle = { ...current };
    if (value === undefined || value === "") {
      delete next[key];
    } else {
      // Widened on purpose: the value came from a control the field spec chose, and
      // NodeStyleSchema is the authority that bounds it on save.
      (next as Record<string, unknown>)[key] = value;
    }
    onChange(next);
  };

  return (
    <div className="space-y-5">
      {GROUP_ORDER.map((group) => {
        const fields = NODE_STYLE_FIELDS.filter((f) => f.group === group);
        if (fields.length === 0) return null;
        return (
          <section key={group} className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
              {t(`themeEditor.style.group.${group}`)}
            </h3>
            <div className="grid gap-3">
              {fields.map((field) => (
                <StyleControl
                  key={field.key}
                  field={field}
                  value={current[field.key]}
                  unitValue={field.unitKey ? current[field.unitKey] : undefined}
                  disabled={disabled}
                  onChange={(value) => set(field.key, value)}
                  onUnitChange={
                    field.unitKey ? (unit) => set(field.unitKey as keyof NodeStyle, unit) : undefined
                  }
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function StyleControl({
  field,
  value,
  unitValue,
  onChange,
  onUnitChange,
  disabled,
}: {
  field: NodeStyleFieldSpec;
  value: string | number | undefined;
  unitValue?: string | number | undefined;
  onChange: (value: string | number | undefined) => void;
  onUnitChange?: (unit: string) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const label = t(field.labelKey);

  if (field.control === "color") {
    return (
      <ColorPicker
        label={label}
        value={typeof value === "string" ? value : undefined}
        disabled={disabled}
        onChange={onChange}
      />
    );
  }

  // A background image: the library's image field (mode="url"), so the URL travels
  // in the LayoutDocument and resolves at render time like any other picked image.
  if (field.control === "image") {
    return (
      <Field label={label} hint={t("themeEditor.style.backgroundImageHint")}>
        <MediaPickerField
          value={typeof value === "string" ? value : ""}
          mode="url"
          onChange={(v) => onChange(v || undefined)}
        />
      </Field>
    );
  }

  // A background video: a URL field with a picker that lists non-image media too.
  if (field.control === "video") {
    return (
      <VideoStyleField
        label={label}
        hint={t("themeEditor.style.backgroundVideoHint")}
        value={typeof value === "string" ? value : ""}
        disabled={disabled}
        onChange={(v) => onChange(v || undefined)}
      />
    );
  }

  if (field.control === "select") {
    return (
      <Field label={label}>
        <Select
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value || undefined)}
        >
          {/* Unset is the absence of the key — distinct from an enum's own "none". */}
          <option value="">{t("themeEditor.style.unset")}</option>
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {t(option.labelKey)}
            </option>
          ))}
        </Select>
      </Field>
    );
  }

  // number (optionally with a unit dropdown pinned inline after the input)
  const numberInput = (
    <Input
      type="number"
      min={field.min}
      max={field.max}
      step={field.step}
      value={typeof value === "number" ? String(value) : ""}
      disabled={disabled}
      onChange={(e) => {
        if (e.target.value === "") return onChange(undefined);
        const next = Number(e.target.value);
        if (!Number.isFinite(next)) return onChange(undefined);
        const min = field.min ?? Number.NEGATIVE_INFINITY;
        const max = field.max ?? Number.POSITIVE_INFINITY;
        onChange(Math.min(max, Math.max(min, next)));
      }}
    />
  );

  if (field.unitKey && field.unitOptions) {
    const fallbackUnit = field.unitOptions[0]?.value ?? "";
    return (
      <Field label={label}>
        <div className="flex gap-2">
          <div className="flex-1">{numberInput}</div>
          <div className="w-24 shrink-0">
            <Select
              value={typeof unitValue === "string" ? unitValue : fallbackUnit}
              disabled={disabled}
              onChange={(e) => onUnitChange?.(e.target.value)}
            >
              {field.unitOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {t(option.labelKey)}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </Field>
    );
  }

  return <Field label={label}>{numberInput}</Field>;
}

/**
 * The background-video control: a URL field plus a picker that lists ALL media
 * (not images-only), so a video already in the library is one click away, and a
 * hosted URL can be pasted directly. The value is a URL that rides in the
 * LayoutDocument and is fenced by CssUrlSchema on save.
 */
function VideoStyleField({
  label,
  hint,
  value,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string | undefined) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <Field label={label} hint={hint}>
      <div className="flex gap-2">
        <Input
          value={value}
          disabled={disabled}
          placeholder="https://…"
          onChange={(e) => onChange(e.target.value || undefined)}
        />
        <Button type="button" disabled={disabled} onClick={() => setOpen(true)} className="shrink-0">
          {t("common.select")}
        </Button>
        {value ? (
          <Button
            type="button"
            variant="ghost"
            disabled={disabled}
            onClick={() => onChange(undefined)}
            className="shrink-0"
          >
            {t("common.clear")}
          </Button>
        ) : null}
      </div>
      <MediaPickerDialog
        open={open}
        onClose={() => setOpen(false)}
        onSelect={([media]) => {
          if (media) onChange(media.url);
          setOpen(false);
        }}
      />
    </Field>
  );
}
