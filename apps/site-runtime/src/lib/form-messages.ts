import { t } from "@zcmsorg/i18n";

/**
 * The words a plugin-declared form says, resolved on the SERVER.
 *
 * `FormIsland` used to carry its own `{ en, vi, ja }` dictionary. That was a
 * platform shipping a hardcoded list of languages inside a component: a site in
 * a fourth language got English from Z-CMS while its theme spoke the visitor's
 * own tongue, and adding a language meant editing a React file rather than a
 * translation file. `@zcmsorg/i18n` already covers "the public runtime's own
 * chrome" — this is that.
 *
 * Resolved here rather than in the island for two reasons:
 *
 *   - the catalogue is a SERVER module, and shipping it to the browser would send
 *     every language the project has ever accepted in order to display one;
 *   - the island is a client component, so a function cannot cross to it. The
 *     count-bearing messages therefore travel as templates carrying `{n}`, which
 *     is the placeholder `@zcmsorg/i18n` already interpolates, and the island
 *     fills in the number it measured against.
 *
 * The one deliberate exception to this pattern is `platform-error.tsx`, which
 * keeps its own copy because it must render when everything else has failed.
 */
export interface FormMessages {
  required: string;
  email: string;
  url: string;
  date: string;
  pattern: string;
  number: string;
  /** Carries `{n}` — the bound the value was measured against. */
  min: string;
  max: string;
  minLength: string;
  maxLength: string;
  invalid: string;
  send: string;
  sending: string;
  ok: string;
  error: string;
  choose: string;
  basket: string;
  removeLine: string;
  less: string;
  more: string;
}

const KEYS = [
  "required",
  "email",
  "url",
  "date",
  "pattern",
  "number",
  "min",
  "max",
  "minLength",
  "maxLength",
  "invalid",
  "send",
  "sending",
  "ok",
  "error",
  "choose",
  "basket",
  "removeLine",
  "less",
  "more",
] as const satisfies readonly (keyof FormMessages)[];

export function formMessages(locale: string): FormMessages {
  const translate = t(locale);
  const out = {} as FormMessages;
  // The `{n}` messages are NOT interpolated here — the number is not known until
  // a value has been measured, in the browser.
  for (const key of KEYS) out[key] = translate(`site.form.${key}`);
  return out;
}
