/**
 * The three viewport widths the studio previews at. `desktop` is null — it means
 * "whatever width the canvas has", the same way the runtime stylesheet treats a wide
 * screen; tablet/mobile pin a fixed CSS pixel width so the responsive rules in
 * widgets.css (which stack columns below 768px) actually engage while designing.
 */
export type StudioDevice = "desktop" | "tablet" | "mobile";

export const STUDIO_DEVICES: readonly StudioDevice[] = ["desktop", "tablet", "mobile"];

/** null = full available width; a number is a fixed CSS-pixel frame. */
export const DEVICE_WIDTH: Record<StudioDevice, number | null> = {
  desktop: null,
  tablet: 768,
  mobile: 390,
};

/** The Icon-registry name for each device's toolbar button. */
export const DEVICE_ICON: Record<StudioDevice, "desktop" | "tablet" | "mobile"> = {
  desktop: "desktop",
  tablet: "tablet",
  mobile: "mobile",
};
