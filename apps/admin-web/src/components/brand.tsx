import { cn } from "@/lib/cn";
import { adminAssetPath } from "@/lib/assets";

/**
 * Z-CMS's own marks.
 *
 * These are the *product's* brand, not a theme's. A theme ships its own logo and
 * favicon (see `ctx.asset` in @zcmsorg/theme-sdk) because a tenant's public site is
 * the tenant's; the admin is Z-CMS, and always looks like it.
 *
 * Both files live in `public/brand/`, so they are served as-is and never bundled.
 */

/** The square mark on its own — the orange Z. Legible where a wordmark would not be. */
export function Logo({ className, size = 28 }: { className?: string; size?: number }) {
  return (
    <img
      src={adminAssetPath("/brand/icon.png")}
      alt=""
      width={size}
      height={size}
      className={cn("shrink-0 object-contain", className)}
      aria-hidden
    />
  );
}

/**
 * The full wordmark.
 *
 * Two files rather than one: the wordmark's "-CMS" is near-black ink, which is
 * invisible on the dark shell, so the dark variant swaps that ink for white and
 * keeps the orange. Which one shows is decided by CSS, not by JavaScript — the
 * theme is applied to <html> before paint (see the bootstrap in layout.tsx), and a
 * component that read the theme in JS would flash the wrong logo on every load.
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2", className)}>
      <img
        src={adminAssetPath("/brand/logo.png")}
        alt="Z-CMS"
        className="h-6 w-auto object-contain dark:hidden"
      />
      <img
        src={adminAssetPath("/brand/logo-dark.png")}
        alt="Z-CMS"
        className="hidden h-6 w-auto object-contain dark:block"
      />
      {/* The mark says Z-CMS; this says *which* Z-CMS surface you are on. */}
      <span className="z-muted text-sm font-normal">Admin</span>
    </span>
  );
}
