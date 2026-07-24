import type { PrismaClient } from "../generated/client";

/**
 * Puts the built-in plugins on a new site — installed, and switched OFF.
 *
 * Two halves, and both are deliberate.
 *
 * **Installed**, because a plugin nobody can find is a plugin nobody uses. zAI is
 * part of what z-cms *is*; making every new site hunt through a catalogue for it is
 * a worse product for no security gain.
 *
 * **INACTIVE, with `grantedPermissions: []`**, because the alternative is a site that
 * silently comes up running third-party-shaped code holding `network:fetch`, without
 * anyone having been asked. The consent screen is where an admin learns that zAI
 * reaches `api.openai.com` and two other hosts — and a consent screen that is skipped
 * for the plugins we happen to ship is a consent screen that means nothing. Ours are
 * the ones it should mean the most for: they are the ones with the most privilege.
 *
 * So the admin still says yes. They just do not have to go looking for the thing to
 * say yes to. Turning it on is one switch, and that switch is where consent happens.
 *
 * Idempotent: a site that already has the plugin is left exactly as it is — including
 * a site where an admin has already granted permissions and turned it on. Re-running
 * the seed must never revoke a grant.
 */
export async function installCorePlugins(
  // Structural, not the full client. Both callers need this: the seed holds a real
  // PrismaClient, while cms-api holds the RLS-scoped TenantClient, which is a subset
  // of one. Asking for only the two delegates this touches lets both pass, and says
  // exactly what the function reaches for.
  db: Pick<PrismaClient, "plugin" | "sitePlugin">,
  tenantId: string,
  siteId: string,
): Promise<string[]> {
  const core = await db.plugin.findMany({
    where: { isCore: true },
    include: { versions: { orderBy: { createdAt: "desc" }, take: 1 } },
  });

  const installed: string[] = [];

  for (const plugin of core) {
    const version = plugin.versions[0];
    // A core plugin with no published version is a broken seed, not a reason to fail
    // creating someone's site.
    if (!version) continue;

    const existing = await db.sitePlugin.findFirst({
      where: { siteId, pluginId: plugin.id },
    });
    if (existing) continue;

    await db.sitePlugin.create({
      data: {
        tenantId,
        siteId,
        pluginId: plugin.id,
        versionId: version.id,
        status: "INACTIVE",
        // Nothing granted. The admin grants on the consent screen, and until they do
        // the plugin can be activated but cannot reach anything — the gateway refuses
        // every scoped method, which is the correct behaviour for a plugin nobody has
        // approved yet.
        grantedPermissions: [],
        settings: {},
      },
    });

    installed.push(plugin.key);
  }

  return installed;
}
