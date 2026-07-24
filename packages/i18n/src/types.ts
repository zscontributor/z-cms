/** A catalogue: nested JSON, leaves are strings. */
export interface Messages {
  [key: string]: string | Messages;
}

/** `t("content.list.empty", { type: "Post" })`. */
export type Translate = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

/**
 * A locale is offered once it covers the strings a user cannot avoid seeing.
 *
 * `experimental` does not mean rejected — the translation is merged, it works,
 * and anyone who sets the locale explicitly gets it. It means Z-CMS does not yet
 * put it in front of a user who has not asked for it, because a language you pick
 * from a menu and then find half in English reads as a broken feature rather than
 * a young translation.
 *
 * Computed, not declared: see `scripts/coverage.ts`.
 */
export type LocaleStatus = "stable" | "experimental";

/** What the language switcher needs to render an entry without a lookup table. */
export interface LocaleInfo {
  /** BCP-47 code, e.g. "en", "vi", "pt-BR". */
  code: string;
  /** English name, for contributor-facing tooling. */
  name: string;
  /** The name as its own speakers write it — the only one a user should see. */
  nativeName: string;
  dir: "ltr" | "rtl";
  status: LocaleStatus;
  /** Percentage of the required namespaces translated. Rounded. */
  coverage: number;
  /**
   * The flag beside the native name — a country code, or null for a language no
   * single country speaks for.
   *
   * Resolved at build time by `flagFor` (see `flags.ts` for why null is a normal
   * answer rather than a missing one), so a contributor adding a language usually
   * writes nothing: the code implies the flag. The `flag` field in locales.json
   * overrides it, in either direction.
   */
  flag: string | null;
}
