"use client";

import type { WidgetPropSpec } from "@zcmsorg/schemas";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/field";
import { useT } from "@/lib/i18n-provider";
import { MediaPickerField } from "@/components/editor/media-picker";
import { RichTextEditor } from "@/components/editor/rich-text-editor";

/**
 * One control per declared prop, switched on `kind`.
 *
 * Mirrors BlockPropsForm deliberately — the two registries describe the same kind
 * of thing (a type, its props, how to draw a control for each) and an editor that
 * rendered them two different ways would be two things to keep in step. The
 * difference is the write cadence: a block form saves on submit, this one reports
 * every keystroke, because the canvas beside it is showing the result.
 */

type Props = Record<string, unknown>;

export function WidgetPropsForm({
  specs,
  props,
  onChange,
  disabled,
}: {
  specs: WidgetPropSpec[];
  props: Props;
  onChange: (props: Props) => void;
  disabled?: boolean;
}) {
  if (specs.length === 0) {
    return null;
  }
  return (
    <div className="grid gap-3">
      {specs.map((spec) => (
        <PropControl
          key={spec.key}
          spec={spec}
          value={props[spec.key]}
          disabled={disabled}
          onChange={(value) => onChange({ ...props, [spec.key]: value })}
        />
      ))}
    </div>
  );
}

function PropControl({
  spec,
  value,
  onChange,
  disabled,
}: {
  spec: WidgetPropSpec;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const label = t(spec.labelKey);
  // `?? ""`: the translator's variables are string|number, and a spec without
  // bounds would otherwise pass undefined for a placeholder its message may not use.
  const hint = spec.hintKey
    ? t(spec.hintKey, { min: spec.min ?? "", max: spec.max ?? "" })
    : undefined;

  switch (spec.kind) {
    case "boolean":
      return (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={typeof value === "boolean" ? value : Boolean(spec.default)}
            disabled={disabled}
            onChange={(e) => onChange(e.target.checked)}
          />
          {label}
        </label>
      );

    case "select":
      return (
        <Field label={label} hint={hint}>
          <Select
            value={String(value ?? spec.default ?? "")}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
          >
            {(spec.options ?? []).map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.labelKey)}
              </option>
            ))}
          </Select>
        </Field>
      );

    case "number":
      return (
        <Field label={label} hint={hint}>
          <Input
            type="number"
            min={spec.min}
            max={spec.max}
            value={String(value ?? spec.default ?? "")}
            disabled={disabled}
            onChange={(e) => {
              const next = Number(e.target.value);
              // An empty box is not zero, and a half-typed number is not a value.
              // Bounds are clamped here because the widget library trusts the
              // document — a span of 900 is not something anybody meant to type.
              if (e.target.value === "" || !Number.isFinite(next)) return onChange(undefined);
              const min = spec.min ?? Number.NEGATIVE_INFINITY;
              const max = spec.max ?? Number.POSITIVE_INFINITY;
              onChange(Math.min(max, Math.max(min, next)));
            }}
          />
        </Field>
      );

    case "color":
      return (
        <Field label={label} hint={hint}>
          <div className="flex items-center gap-2">
            <input
              type="color"
              className="h-9 w-12 cursor-pointer rounded border border-neutral-300 bg-transparent dark:border-neutral-700"
              value={typeof value === "string" && value ? value : "#000000"}
              disabled={disabled}
              onChange={(e) => onChange(e.target.value)}
            />
            {/* The hex box stays: a colour picker cannot express "unset", and a
                brand colour arrives as a string somebody was given, not a swatch
                they will find by eye. */}
            <Input
              value={typeof value === "string" ? value : ""}
              placeholder="#000000"
              disabled={disabled}
              onChange={(e) => onChange(e.target.value)}
            />
          </div>
        </Field>
      );

    case "image":
      return (
        <Field label={label} hint={hint}>
          {/* `mode="url"`: a widget's image prop travels inside the LayoutDocument
              and is resolved at render time by ctx.asset, which takes a path — not
              a media id this site happens to hold. A theme installed elsewhere
              would have no such row. */}
          <MediaPickerField
            value={typeof value === "string" ? value : ""}
            mode="url"
            onChange={onChange}
          />
        </Field>
      );

    case "html":
      return (
        <Field label={label} hint={hint}>
          <RichTextEditor
            value={typeof value === "string" ? value : ""}
            disabled={disabled}
            onChange={onChange}
          />
        </Field>
      );

    case "textarea":
      return (
        <Field label={label} hint={hint}>
          <Textarea
            rows={3}
            value={typeof value === "string" ? value : ""}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
          />
        </Field>
      );

    case "url":
    case "text":
    default:
      return (
        <Field label={label} hint={hint}>
          <Input
            value={typeof value === "string" ? value : ""}
            placeholder={spec.placeholderKey ? t(spec.placeholderKey) : undefined}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
          />
        </Field>
      );
  }
}
