"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { MediaPickerDialog } from "@/components/editor/media-picker";
import { Icon } from "@/components/shell/icon";
import { useT } from "@/lib/i18n-provider";

/**
 * The control behind a widget's `imageList` prop (e.g. a gallery's images).
 *
 * It stores an ordered list of URLs — the same shape a single media prop stores as
 * one string — chosen from the Media library. Adding opens the shared picker in
 * multi/images-only mode; the library is the source of truth, so a gallery is real
 * uploaded media, not a private blob. Order is selection order; removing is per-tile.
 */
export function ImageListField({
  value,
  onChange,
  disabled,
}: {
  value: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);

  const add = (urls: string[]) => {
    // Dedupe against what is already picked — selecting the same file twice should
    // not put it in the gallery twice.
    const next = [...value];
    for (const url of urls) if (!next.includes(url)) next.push(url);
    onChange(next);
  };

  const removeAt = (index: number) => onChange(value.filter((_, i) => i !== index));

  return (
    <div className="space-y-2">
      {value.length > 0 ? (
        <div className="grid grid-cols-3 gap-2">
          {value.map((url, i) => (
            <div key={`${url}-${i}`} className="group relative aspect-square overflow-hidden rounded border border-neutral-300 dark:border-neutral-700">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={url} alt="" className="h-full w-full object-cover" />
              <button
                type="button"
                disabled={disabled}
                onClick={() => removeAt(i)}
                aria-label={t("common.delete")}
                className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100"
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <Button variant="ghost" size="sm" disabled={disabled} onClick={() => setOpen(true)}>
        {t("themeEditor.props.addImages")}
      </Button>

      <MediaPickerDialog
        open={open}
        onClose={() => setOpen(false)}
        multiple
        imagesOnly
        onSelect={(media) => {
          add(media.map((m) => m.url));
          setOpen(false);
        }}
      />
    </div>
  );
}
