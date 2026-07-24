import type { ReactNode } from "react";
import type {
  ColorMode,
  ColorModeContext,
  ColorModePreference,
  ThemeContext,
  ThemeManifest,
} from "./types";

/**
 * Colour mode — the theme's half of the contract.
 *
 * The runtime's half is a script on the document that sets `data-theme` on <html>,
 * remembers the visitor's choice, and listens for clicks. This file is everything a
 * theme needs in order to meet it without knowing any of that:
 *
 *     import { ColorModeToggle } from "@zcmsorg/theme-sdk";
 *
 *     <ColorModeToggle ctx={ctx} className="mytheme__icon-btn" />
 *
 * and then, in the theme's stylesheet:
 *
 *     html[data-theme="dark"] .mytheme { --paper: #11110f; --ink: #f3f0e8; }
 *
 * That is the whole API. No client bundle, no state, no effect — the button is
 * static HTML, and the runtime finds it by the attribute this component puts on it.
 *
 * Before this existed the attribute name WAS the API: a theme had to write
 * `data-z-theme-toggle` by hand, spell it correctly, remember `aria-pressed`, and
 * hand-roll the icon swap in CSS. That is a convention, not a contract — nothing
 * checked it, and a typo produced a button that simply did nothing.
 */

/** The attribute the runtime sets on <html>. A theme styles against it. */
export const COLOR_MODE_ATTRIBUTE = "data-theme";

/** The marker that makes an element a toggle. The runtime listens for it. */
export const COLOR_MODE_TOGGLE_ATTRIBUTE = "data-z-theme-toggle";

/** Marks the two icons inside a toggle. The runtime's stylesheet shows one. */
export const COLOR_MODE_ICON_ATTRIBUTE = "data-z-theme-icon";

/** Where the visitor's choice is remembered. */
export const COLOR_MODE_STORAGE_KEY = "zcms-color-mode";

/** What a theme gets when its manifest says nothing: both modes, follow the OS. */
export const DEFAULT_COLOR_MODE: ColorModeContext = {
  modes: ["light", "dark"],
  default: "system",
  toggleable: true,
  attribute: COLOR_MODE_ATTRIBUTE,
};

function isColorMode(value: unknown): value is ColorMode {
  return value === "light" || value === "dark";
}

function isPreference(value: unknown): value is ColorModePreference {
  return isColorMode(value) || value === "system";
}

/**
 * Resolves the manifest's declaration (and the owner's setting) into the object a
 * theme sees as `ctx.colorMode`.
 *
 * Both the runtime and the SDK call this, and that is the point: the script that
 * decides which mode to apply and the component that decides whether to draw a
 * switch must not be able to reach different conclusions. A theme whose toggle is
 * visible but inert is worse than one with no toggle at all.
 *
 * `settings.colorMode` — when a theme offers it — is the SITE OWNER's choice of
 * starting mode, and it beats the theme's own default. It cannot, however, widen
 * what the theme supports: an owner who sets "dark" on a light-only theme is asking
 * for a page the theme has no colours for, so the request is dropped rather than
 * honoured into an unreadable site.
 */
export function resolveColorModes(
  manifest: Pick<ThemeManifest, "colorModes">,
  settings?: Record<string, unknown> | null,
): ColorModeContext {
  const declared = manifest.colorModes ?? {};

  // Deduped and filtered: a manifest is data from a package, and "supports":
  // ["dark", "dark", "purple"] is a thing a hand-edited theme.json can say.
  const supported = (declared.supports ?? []).filter(isColorMode);
  const modes: ColorMode[] = supported.length
    ? [...new Set(supported)]
    : ["light", "dark"];

  const toggleable = modes.length > 1;

  const owner = settings?.colorMode;
  const preference: ColorModePreference = isPreference(owner)
    ? owner
    : isPreference(declared.default)
      ? declared.default
      : "system";

  // A single-mode theme has no default worth naming: whatever the manifest or the
  // owner said, there is exactly one page this theme can draw, and "system" would
  // ask the runtime to choose between one thing and nothing.
  const resolved: ColorModePreference = !toggleable
    ? modes[0]!
    : preference !== "system" && !modes.includes(preference)
      ? "system"
      : preference;

  return {
    modes,
    default: resolved,
    toggleable,
    attribute: COLOR_MODE_ATTRIBUTE,
  };
}

export interface ColorModeToggleProps {
  ctx: ThemeContext<never> | ThemeContext<any>;
  /** The theme's own button class. The SDK ships no styling of its own. */
  className?: string;
  /** Accessible name. Defaults to the theme's `colorMode.toggle` message. */
  label?: string;
  /** Shown while the document is LIGHT — i.e. the icon that offers dark. */
  lightIcon?: ReactNode;
  /** Shown while the document is DARK. */
  darkIcon?: ReactNode;
}

/**
 * The dark/light switch.
 *
 * Renders `null` when the theme supports a single mode — a switch with nowhere to
 * go is a bug that looks like a feature, and this is the one place it can be
 * prevented for every theme at once.
 *
 * Both icons are rendered and the runtime's stylesheet shows exactly one, keyed off
 * `data-theme` on <html>. Choosing in JavaScript would mean the theme shipping
 * JavaScript; choosing on the server would mean choosing before the visitor's
 * preference is known, and being wrong for the first frame.
 *
 * `aria-pressed="false"` is a starting value, not a claim: the runtime corrects it
 * the moment it knows the real mode, which is before the button can be clicked.
 */
export function ColorModeToggle({
  ctx,
  className,
  label,
  lightIcon,
  darkIcon,
}: ColorModeToggleProps): ReactNode {
  if (!ctx.colorMode.toggleable) return null;

  // The theme's catalogue first, so the label is in the reader's language; the
  // English fallback is here so that a theme which forgot the key still ships a
  // button that a screen reader can announce.
  const translated = ctx.t("colorMode.toggle");
  const name =
    label ?? (translated === "colorMode.toggle" ? "Toggle dark mode" : translated);

  const attributes = {
    [COLOR_MODE_TOGGLE_ATTRIBUTE]: "",
  } as Record<string, string>;

  return (
    <button
      type="button"
      className={className}
      aria-pressed="false"
      aria-label={name}
      title={name}
      {...attributes}
    >
      <span {...{ [COLOR_MODE_ICON_ATTRIBUTE]: "light" }} aria-hidden="true">
        {lightIcon ?? "☾"}
      </span>
      <span {...{ [COLOR_MODE_ICON_ATTRIBUTE]: "dark" }} aria-hidden="true">
        {darkIcon ?? "☀"}
      </span>
    </button>
  );
}
