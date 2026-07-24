import { flagUrl } from "@zcmsorg/i18n/client";
import { adminAssetPath } from "@/lib/assets";
import { cn } from "@/lib/cn";

/**
 * The flag beside a language's name — or its code, when it has no flag.
 *
 * Never on its own. A flag does not say which language a row is (see the note in
 * `@zcmsorg/i18n`'s flags.ts — a language is not a country, and for Arabic or
 * Esperanto there is no honest flag at all). It is a visual anchor next to the
 * name that does the naming, which is why this is `aria-hidden`: a screen reader
 * already reads "Tiếng Việt" and gains nothing from "flag of Vietnam".
 *
 * When there is no flag, the locale code takes the slot at the same width. The
 * row does not reflow, nothing is missing, and the layout was never depending on
 * the image being there — which is the property that makes it safe to render
 * flags for languages at all.
 *
 * Not an `<Icon>`: those are monochrome Phosphor glyphs that inherit
 * `currentColor`, and a flag is a picture. The registry in icon.tsx is the wrong
 * home for 271 images that never take the text colour.
 */
export function Flag({
  locale,
  flag,
  className,
}: {
  locale: string;
  /**
   * The resolved country code, when the caller already has one — a `LocaleInfo`
   * from the registry carries it. Omit it for a locale that came from the
   * database (a site's languages are rows, not registry entries) and it is
   * derived from the code.
   */
  flag?: string | null;
  className?: string;
}) {
  const source = flag !== undefined ? flagUrl(locale, flag) : flagUrl(locale);
  const src = source ? adminAssetPath(source) : null;

  // 4x3, the proportions a flag is recognised at. The ring is not decoration:
  // Japan and Poland are mostly white, and without it they dissolve into a light
  // background and read as a missing image.
  const box = cn("h-[15px] w-5 shrink-0 rounded-[2px]", className);

  if (!src) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          box,
          "flex items-center justify-center bg-[var(--surface-sunken)]",
          "font-mono text-[9px] uppercase leading-none z-muted",
        )}
      >
        {locale.slice(0, 2)}
      </span>
    );
  }

  return (
    // Not next/image: these are static SVGs of a known size, served from
    // `public/`. The optimiser has nothing to optimise and would only put a
    // rasteriser in front of a vector.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      aria-hidden="true"
      width={20}
      height={15}
      loading="lazy"
      className={cn(box, "object-cover ring-1 ring-inset ring-black/10")}
    />
  );
}
