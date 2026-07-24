/**
 * `@zcmsorg/i18n/client` — everything a browser bundle may import, and nothing else.
 *
 * The difference between this entrypoint and the root one is a single missing
 * line: it does not re-export `./catalog`. That omission is the feature.
 *
 * A client component needs three things — the locale codes for the switcher, the
 * translator function, and the types. It does not need the messages of every
 * language the project ships: those arrive from the server, already resolved for
 * the one locale the user actually reads (see `messagesFor` in the root entry).
 *
 * Enforcing that by convention would mean someone eventually writes
 * `import { catalog } from "@zcmsorg/i18n"` in a "use client" file, ships forty
 * languages to every browser, and nobody notices because nothing breaks — the
 * admin just gets quietly heavier with every translation PR merged. Enforcing it
 * in the module graph means that import cannot resolve.
 */
export * from "./types";
export * from "./translator";
export * from "./locales";
export * from "./flags";
