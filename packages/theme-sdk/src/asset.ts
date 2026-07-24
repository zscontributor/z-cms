/**
 * Where a theme's own files are served from.
 *
 * A theme names a file relative to its own package root ("assets/logo.png"). It
 * cannot do better than that: it is installed under a key and a version it does
 * not choose, into a cache directory it never sees — and the same theme, compiled
 * into the runtime as the built-in fallback, has no package directory at all. The
 * runtime is the only side that knows which of those happened, so the runtime
 * supplies the base and the theme supplies the name.
 *
 * This is the counterpart of `ctx.url`: that one resolves a path through the
 * site's *content* (locale prefixes and all), this one through the theme's
 * *package*.
 */

/**
 * True for a path that already names where it lives: a site-root path, a full
 * URL, or a protocol-relative one.
 *
 * These are left alone. It is what lets a theme wrap a *setting* in `asset()`
 * without asking where the value came from — the logo it ships is relative, the
 * logo an owner uploaded is an absolute media URL, and both go through the same
 * call.
 */
export function isAbsoluteAssetPath(path: string): boolean {
  return (
    path.startsWith("/") || path.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(path)
  );
}

/**
 * Joins a theme-relative path onto that theme's asset base.
 *
 * `base` is expected to be a site-root path ending in "/" — the runtime builds it;
 * a theme never does. A blank path resolves to nothing rather than to the base
 * itself, so an unset icon setting cannot turn into a link to a directory.
 */
export function resolveAssetUrl(base: string, path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "";
  if (isAbsoluteAssetPath(trimmed)) return trimmed;

  const left = base.endsWith("/") ? base : `${base}/`;
  const right = trimmed.startsWith("./") ? trimmed.slice(2) : trimmed;

  return `${left}${right}`;
}
