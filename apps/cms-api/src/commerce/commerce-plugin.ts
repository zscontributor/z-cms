import type { PluginManifest } from "@zcmsorg/plugin-sdk";

/**
 * Commerce as a first-party plugin — the catalogue identity of a feature whose
 * code stays in core.
 *
 * The storefront's engine (pricing, orders, the money authority) belongs in the
 * database layer, not a V8 isolate, so commerce is a `runtime: "core"` plugin: a
 * manifest with no bundle. What that manifest buys is everything the user asked
 * for — the shop is now catalogued, consented to, and ACTIVATED PER SITE like any
 * other plugin, which is precisely what makes the Orders menu appear only where
 * commerce is switched on, exactly as WooCommerce does.
 *
 * The permissions it PROVIDES are the ones that used to be baked into the EDITOR
 * and ADMIN roles. Moving them here is the whole mechanism: a role holds them only
 * while this plugin is active on the site (resolved by `pluginPermissionGrants`),
 * so a blog with no shop grants none of them and shows none of the shop. The keys
 * are bare (`order:read`, not `x:...`) because a first-party plugin may mint them —
 * they stay first-class core permissions that the Orders controller and the
 * consent screen already speak.
 *
 * `defaultRoles` lists each role explicitly rather than "EDITOR and up": a session
 * carries one resolved role, so OWNER must be named to receive what ADMIN does.
 */
export const COMMERCE_PLUGIN_KEY = "vn.zsoft.commerce";

export const COMMERCE_PLUGIN_MANIFEST: PluginManifest = {
  id: COMMERCE_PLUGIN_KEY,
  name: "Commerce",
  version: "1.0.0",
  description:
    "The storefront: a cart, COD checkout and orders. Activate it on a site to turn " +
    "that site into a shop; leave it off and the site has no commerce at all.",
  author: { name: "Z-SOFT" },
  engine: ">=0.1.0",
  // No bundle — the logic is the core CommerceModule. See PluginManifest.runtime.
  runtime: "core",
  // It requests no core scopes: it does not call the plugin gateway, it IS core.
  permissions: [],
  // What themes feature-detect to render a storefront; also the capability the
  // commerce render projector is keyed to.
  capabilities: ["commerce.checkout"],
  permissionsProvided: [
    {
      key: "order:read",
      description:
        "Read the shop's orders — customer names, contact details and delivery addresses.",
      defaultRoles: ["EDITOR", "ADMIN", "OWNER"],
    },
    {
      key: "order:manage",
      description: "Move an order along: confirm, fulfil, cancel or refund it.",
      defaultRoles: ["ADMIN", "OWNER"],
    },
    {
      key: "commerce:configure",
      description: "Configure the storefront: currency, shipping and payment methods.",
      defaultRoles: ["ADMIN", "OWNER"],
    },
  ],
};
