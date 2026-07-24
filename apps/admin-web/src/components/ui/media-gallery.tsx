"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/shell/icon";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n-provider";

/**
 * A package's screenshots, and a lightbox to see one properly.
 *
 * Thumbnails in a card are too small to judge a theme by, which is the only thing
 * a screenshot is for — so the gallery's job is really to get out of the way and
 * hand you the full image. Hence the lightbox, and hence arrow keys: someone
 * comparing three screenshots should not have to close and reopen twice.
 *
 * At most three images ever arrive here — the package format refuses a fourth
 * (MAX_SCREENSHOTS) — so there is no carousel, no lazy window, no virtualisation.
 * A row of three is a row of three.
 */
export function MediaGallery({
  screenshots,
  video,
  name,
  className,
}: {
  screenshots: string[];
  video?: string | null;
  name: string;
  className?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState<number | null>(null);

  if (screenshots.length === 0 && !video) return null;

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {screenshots.length > 0 ? (
        <ul className="grid grid-cols-3 gap-1.5">
          {screenshots.map((src, index) => (
            <li key={src} className="min-w-0">
              <button
                type="button"
                onClick={() => setOpen(index)}
                className="group relative block w-full overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface-sunken)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50"
                aria-label={t("admin.marketplace.media.viewShot", {
                  n: String(index + 1),
                  name,
                })}
              >
                {/* A fixed aspect box, because three screenshots of three different
                    shapes would otherwise make the card jump around as they load. */}
                <span className="block aspect-[16/10]">
                  <img
                    src={src}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
                  />
                </span>
                <span className="pointer-events-none absolute inset-0 bg-black/0 transition-colors group-hover:bg-black/15" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {video ? (
        <a
          href={video}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1.5 text-[11px] font-medium text-brand-600 hover:underline dark:text-brand-400"
        >
          <Icon name="play" className="h-3.5 w-3.5" />
          {t("admin.marketplace.media.watchVideo")}
        </a>
      ) : null}

      {open !== null ? (
        <Lightbox
          screenshots={screenshots}
          index={open}
          name={name}
          onClose={() => setOpen(null)}
          onIndex={setOpen}
        />
      ) : null}
    </div>
  );
}

/**
 * The full image, over everything.
 *
 * Rendered through a portal onto <body>: a fixed-position overlay inside a card
 * is still trapped by any ancestor with `overflow: hidden` or a transform — and
 * the card grid has both. Portalling is the only way an overlay is reliably over
 * *everything* rather than over most things.
 */
function Lightbox({
  screenshots,
  index,
  name,
  onClose,
  onIndex,
}: {
  screenshots: string[];
  index: number;
  name: string;
  onClose: () => void;
  onIndex: (index: number) => void;
}) {
  const t = useT();
  const [mounted, setMounted] = useState(false);

  const count = screenshots.length;
  const go = useCallback(
    (delta: number) => onIndex((index + delta + count) % count),
    [index, count, onIndex],
  );

  // `createPortal` needs a DOM, and this component is rendered on the server first.
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowRight") go(1);
      if (event.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey);

    // The page behind must not scroll while the lightbox is up — on a trackpad it
    // is otherwise very easy to scroll the card grid out from under the overlay.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose, go]);

  if (!mounted) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={name}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      // The backdrop closes; a click that started on the image does not. Without
      // the target check, dragging to select on the image would close the dialog.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label={t("common.close")}
        className="absolute right-4 top-4 rounded-md p-2 text-white/80 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
      >
        <Icon name="close" className="h-5 w-5" />
      </button>

      {count > 1 ? (
        <button
          type="button"
          onClick={() => go(-1)}
          aria-label={t("admin.marketplace.media.previous")}
          className="absolute left-4 rounded-md p-2 text-white/80 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
        >
          <Icon name="chevron-left" className="h-6 w-6" />
        </button>
      ) : null}

      <figure className="flex max-h-full max-w-5xl flex-col items-center gap-3">
        <img
          src={screenshots[index]}
          alt={t("admin.marketplace.media.viewShot", {
            n: String(index + 1),
            name,
          })}
          className="max-h-[80vh] w-auto max-w-full rounded-lg object-contain shadow-2xl"
        />
        {count > 1 ? (
          <figcaption className="text-xs text-white/70">
            {index + 1} / {count}
          </figcaption>
        ) : null}
      </figure>

      {count > 1 ? (
        <button
          type="button"
          onClick={() => go(1)}
          aria-label={t("admin.marketplace.media.next")}
          className="absolute right-4 rounded-md p-2 text-white/80 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
        >
          <Icon name="chevron-right" className="h-6 w-6" />
        </button>
      ) : null}
    </div>,
    document.body,
  );
}
