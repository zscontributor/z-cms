"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/field";
import { useT } from "@/lib/i18n-provider";

/**
 * The control behind a `reference` field: type to search, click to choose.
 *
 * Before this, `refTable` was a hint nothing read. A reference rendered as a plain
 * text box, so "which member of staff is on this shift" was answered by finding a
 * uuid on another screen and pasting it — which is not a question a rota should
 * ask anybody.
 *
 * It is a combobox rather than a `<select>` on purpose. A shop with forty staff, a
 * menu with two hundred items: a native select is a scroll, and the first thing
 * anyone does with a long one is try to type into it. The list comes from the
 * server on each search, so it is never a stale copy of the table and never the
 * whole table either — twenty rows, filtered by the same substring rule the list
 * screen's search box uses.
 */

interface Option {
  value: string;
  label: string;
}

export function ReferenceField({
  pluginKey,
  resourceKey,
  column,
  value,
  disabled,
  onChange,
}: {
  pluginKey: string;
  resourceKey: string;
  column: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string | null) => void;
}) {
  const t = useT();
  const [term, setTerm] = useState("");
  const [options, setOptions] = useState<Option[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  /**
   * What the STORED value is called.
   *
   * Kept apart from the search results because it has to survive them: the list is
   * replaced on every keystroke, and the row being edited already points at
   * something whose name must not blink out while somebody looks for a different
   * one. Without this the form showed the uuid it had stored — which is exactly
   * the thing this control exists to stop anyone having to read.
   */
  const [chosenLabel, setChosenLabel] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const endpoint = useMemo(
    () =>
      `/api/plugin-admin/${encodeURIComponent(pluginKey)}/${encodeURIComponent(
        resourceKey,
      )}/options/${encodeURIComponent(column)}`,
    [pluginKey, resourceKey, column],
  );

  // One lookup, when the form opens on a row that already has a reference.
  useEffect(() => {
    if (!value) {
      setChosenLabel(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${endpoint}?value=${encodeURIComponent(value)}`, {
          cache: "no-store",
        });
        const data = res.ok ? ((await res.json()) as { options?: Option[] }) : { options: [] };
        const found = data.options?.[0];
        if (!cancelled && found) setChosenLabel(found.label);
      } catch {
        // The raw value is shown instead — worse to read, never wrong.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [endpoint, value]);

  // Debounced: a keystroke is not a query. 250ms is under the threshold where a
  // list feels like it lags behind the typing.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`${endpoint}?q=${encodeURIComponent(term)}`, {
          cache: "no-store",
        });
        const data = res.ok ? ((await res.json()) as { options?: Option[] }) : { options: [] };
        if (!cancelled) setOptions(data.options ?? []);
      } catch {
        if (!cancelled) setOptions([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [endpoint, term, open]);

  // Clicking anywhere else closes the list. Without this the dropdown outlives the
  // question it was answering.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // While searching, the box holds the search. Otherwise it holds the name of what
  // is chosen, falling back to the stored value only if the lookup found nothing.
  const display = open
    ? term
    : (chosenLabel ?? options.find((option) => option.value === value)?.label ?? value);

  return (
    <div className="relative" ref={boxRef}>
      <Input
        value={display}
        disabled={disabled}
        placeholder={t("plugins.resource.referenceSearch")}
        onFocus={() => {
          setTerm("");
          setOpen(true);
        }}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
          setTerm(e.target.value);
          setOpen(true);
        }}
      />
      {value && !open ? (
        <button
          type="button"
          className="absolute right-2 top-1/2 -translate-y-1/2 text-xs z-muted hover:underline"
          onClick={() => onChange(null)}
        >
          {t("common.clear")}
        </button>
      ) : null}

      {open ? (
        // `z-card` carries the admin's own raised surface, border and shadow. The
        // hand-written variables this used to name (`--z-surface`) do not exist, so
        // the panel had NO background: the next field's label showed straight
        // through it.
        <ul className="z-card absolute z-30 mt-1 max-h-64 w-full overflow-auto py-1">
          {loading && options.length === 0 ? (
            <li className="px-3 py-2 text-sm z-muted">{t("common.loading")}</li>
          ) : options.length === 0 ? (
            <li className="px-3 py-2 text-sm z-muted">{t("plugins.resource.referenceEmpty")}</li>
          ) : (
            options.map((option) => (
              <li key={option.value}>
                <button
                  type="button"
                  className="block w-full px-3 py-2 text-left text-sm hover:bg-[var(--surface-sunken)]"
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                >
                  {option.label}
                  <span className="ml-2 text-xs z-muted">{option.value}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
