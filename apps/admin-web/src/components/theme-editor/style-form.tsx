"use client";

import {
  NODE_STYLE_FIELDS,
  type NodeStyle,
  type NodeStyleFieldSpec,
  type NodeStyleGroup,
} from "@zcmsorg/schemas";
import { Field, Input, Select } from "@/components/ui/field";
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
                  disabled={disabled}
                  onChange={(value) => set(field.key, value)}
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
  onChange,
  disabled,
}: {
  field: NodeStyleFieldSpec;
  value: string | number | undefined;
  onChange: (value: string | number | undefined) => void;
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

  // number
  return (
    <Field label={label}>
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
    </Field>
  );
}
