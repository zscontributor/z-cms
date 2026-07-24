"use client";

import {
  BASE_LOCALE,
  createMessageTranslator,
  type Messages,
  type Translate,
} from "@zcmsorg/i18n/client";
import { createContext, useContext, useMemo, type ReactNode } from "react";

/**
 * The admin's language, on the client.
 *
 * The messages are bundled into the page rather than fetched: loading them over
 * the network means every client component renders once with no strings at all
 * before they arrive, and a flash of untranslated UI is a worse trade than the
 * bytes.
 *
 * But "bundled" used to mean the *whole catalogue* — every locale, imported
 * statically, shipped to every browser. That is fine at two languages and absurd
 * at twenty: a Vietnamese admin would download Japanese, Arabic and Polish to
 * read none of them, and the cost would grow with every translation PR the
 * project was pleased to merge. Success would have made the admin slower.
 *
 * So the server resolves the one locale the user actually reads — English
 * fallback already folded in, via `messagesFor` — and passes it down. The
 * messages ride along in the RSC payload with the first HTML: no round trip, no
 * flash, and a payload whose size no longer depends on how many languages exist.
 *
 * This file imports from `@zcmsorg/i18n/client`, which does not export `catalog` at
 * all. Reintroducing the old behaviour would not be a subtle regression — it
 * would be an import that does not resolve.
 *
 * Server components do not use any of this; they read the cookie directly and
 * call `getT()` (see `lib/locale.ts`).
 */
interface LocaleContextValue {
  locale: string;
  messages: Messages;
}

const LocaleContext = createContext<LocaleContextValue>({
  locale: BASE_LOCALE,
  messages: {},
});

export function LocaleProvider({
  locale,
  messages,
  children,
}: {
  locale: string;
  messages: Messages;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ locale, messages }), [locale, messages]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): string {
  return useContext(LocaleContext).locale;
}

/** `const t = useT(); <button>{t("common.save")}</button>` */
export function useT(): Translate {
  const { messages } = useContext(LocaleContext);
  return useMemo(() => createMessageTranslator(messages), [messages]);
}
