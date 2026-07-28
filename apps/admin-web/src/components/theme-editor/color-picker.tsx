"use client";

import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { useT } from "@/lib/i18n-provider";

/**
 * A colour control that can also say "unset".
 *
 * Three pieces, and each earns its place: a native swatch for picking by eye, a hex
 * box because a brand colour arrives as a string somebody was handed (and because
 * `<input type=color>` cannot express rgb()/hsl() or an empty value), and a Clear
 * that returns to the stylesheet's own default. Unset is a real state — the only way
 * back to the theme token — so it is not something a swatch alone can represent.
 *
 * Shared by the theme tokens, per-node style, and widget `color` props so the three
 * places a colour is chosen look and behave as one control.
 */
export function ColorPicker({
  label,
  value,
  onChange,
  disabled,
  hint,
}: {
  label: string;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  disabled?: boolean;
  hint?: string;
}) {
  const t = useT();
  return (
    <Field label={label} hint={hint}>
      <div className="flex items-center gap-2">
        <input
          type="color"
          className="h-9 w-12 shrink-0 cursor-pointer rounded border border-neutral-300 bg-transparent dark:border-neutral-700"
          // A swatch has to show SOMETHING; black is the least surprising stand-in
          // for "no colour yet" and never leaks into the document unless picked.
          value={/^#[0-9a-fA-F]{6}$/.test(value ?? "") ? (value as string) : "#000000"}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
        <Input
          value={value ?? ""}
          placeholder={t("themeEditor.style.unset")}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value || undefined)}
        />
        {value ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => onChange(undefined)}
          >
            {t("themeEditor.tokens.clear")}
          </Button>
        ) : null}
      </div>
    </Field>
  );
}
