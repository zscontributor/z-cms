import {
  LAYOUT_TEMPLATES,
  collectDocumentCollections,
  type CollectionQuery,
  type LayoutDocument,
} from "@zcmsorg/schemas";

/**
 * The theme.json a drawing becomes.
 *
 * Every field here is DERIVED — nothing is asked of the author twice. The
 * collections come from the widgets they bound, the templates from the ones they
 * drew, the settings schema from the tokens the widget library reads. A manifest
 * field a person could contradict by drawing something else would be a manifest
 * that lies about the theme.
 */

export interface ThemeIdentity {
  /** Reverse-DNS key, e.g. "com.acme.theme.shop". */
  id: string;
  name: string;
  version: string;
  description?: string;
  authorName: string;
  authorUrl?: string;
}

/**
 * A token becomes a setting, so a site owner can re-colour a downloaded theme with
 * no code and no rebuild. `format` is what makes the admin draw a colour picker
 * rather than a text box — see theme-schema.ts.
 */
const TOKEN_SETTINGS: Record<
  string,
  { type: "string" | "number"; title: string; format?: "color" }
> = {
  colorPrimary: { type: "string", title: "Primary colour", format: "color" },
  colorText: { type: "string", title: "Text colour", format: "color" },
  colorBackground: { type: "string", title: "Background", format: "color" },
  fontHeading: { type: "string", title: "Heading font" },
  fontBody: { type: "string", title: "Body font" },
  radius: { type: "number", title: "Corner radius" },
  maxWidth: { type: "number", title: "Max content width" },
};

/**
 * The engine range a generated theme claims.
 *
 * Pinned to the major it was drawn against, not `>=0.1.0`. A drawn theme is
 * interpreted by a widget library that ships INSIDE it, so it is not at the mercy
 * of a runtime change the way a hand-written theme is — but the ThemeContext it
 * reads is still core's contract, and claiming compatibility with a version that
 * does not exist yet is a promise nobody made.
 */
export const GENERATED_ENGINE = ">=0.1.0 <2.0.0";

export interface GeneratedManifest {
  id: string;
  name: string;
  version: string;
  kind: "theme";
  description?: string;
  author: { name: string; url?: string };
  engine: string;
  entry: string;
  styles: string;
  templates: string[];
  menuLocations: { key: string; name: string }[];
  settingsSchema: {
    type: "object";
    properties: Record<string, { type: string; title?: string; format?: string; default?: unknown }>;
  };
  collections: Record<string, CollectionQuery>;
}

/**
 * Menu locations a drawing actually names.
 *
 * A `layout/menu` widget names a location; the manifest has to declare it or the
 * site has nowhere to assign a menu to, and the widget renders nothing forever.
 * Derived from the document rather than asked for, for exactly that reason.
 */
export function collectMenuLocations(doc: LayoutDocument): { key: string; name: string }[] {
  const keys = new Set<string>();
  for (const template of LAYOUT_TEMPLATES) {
    const tree = doc.templates[template];
    if (!tree) continue;
    const stack = [...tree];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node.kind === "widget" && node.widgetType === "layout/menu") {
        const location = node.props.location;
        if (typeof location === "string" && location.trim()) keys.add(location.trim());
      }
      for (const child of node.children ?? []) stack.push(child);
    }
  }
  // Sorted so the same drawing always produces the same manifest — the build must
  // be reproducible, and a Set's insertion order is a detail of the walk.
  return [...keys].sort().map((key) => ({ key, name: key }));
}

export function buildManifest(identity: ThemeIdentity, doc: LayoutDocument): GeneratedManifest {
  const properties: GeneratedManifest["settingsSchema"]["properties"] = {};
  for (const [key, spec] of Object.entries(TOKEN_SETTINGS)) {
    const drawn = doc.tokens[key as keyof typeof doc.tokens];
    properties[key] = {
      type: spec.type,
      title: spec.title,
      ...(spec.format ? { format: spec.format } : {}),
      // The drawing's value is the DEFAULT. A site that never touches the settings
      // form renders exactly what the author drew.
      ...(drawn !== undefined ? { default: drawn } : {}),
    };
  }

  return {
    id: identity.id,
    name: identity.name,
    version: identity.version,
    kind: "theme",
    ...(identity.description ? { description: identity.description } : {}),
    author: { name: identity.authorName, ...(identity.authorUrl ? { url: identity.authorUrl } : {}) },
    engine: GENERATED_ENGINE,
    entry: "dist/index.mjs",
    styles: "dist/theme.css",
    // `page` always ships: it is the only required template, and the one every
    // other falls back to. The rest appear only if they were drawn.
    templates: LAYOUT_TEMPLATES.filter((name) => name === "page" || doc.templates[name]),
    menuLocations: collectMenuLocations(doc),
    settingsSchema: { type: "object", properties },
    collections: collectDocumentCollections(doc),
  };
}
