import "dotenv/config";
import path from "node:path";
import { config as loadEnv } from "dotenv";

loadEnv({ path: path.resolve(__dirname, "../../../.env"), quiet: true });

import { getSystemDb, disconnectDb } from "../src/clients";

/**
 * Turn a live site trilingual — the operational half of "add i18n to z-cms.org".
 *
 * The default theme already ships the language switcher and its EN/VI/JA strings; it
 * renders only when a page exists in more than one of the site's locales, because
 * cms-api builds `ctx.alternates` from PUBLISHED translation siblings. So making a
 * running site multilingual is two steps, and this does the mechanical one and
 * reports the human one:
 *
 *   1. add the locales to `Site.locales`, so /vi and /ja resolve at all, and
 *   2. list, per translation group, which locales still have no published page —
 *      the exact set of translations an editor has to author in the admin before the
 *      switcher appears on that page.
 *
 * It never invents a translation: publishing an untranslated stub would put a locale
 * in the switcher whose page is really in another language, which is worse than no
 * switcher. Step 2 is a to-do list, not an action.
 *
 * Dry-run by default. It only writes to `Site.locales` when passed --apply, and
 * writes nothing else, ever.
 *
 *   Target the site by primary hostname (defaults to $ROOT_DOMAIN), or by slug:
 *
 *     pnpm --filter @zcmsorg/database locales:enable                 # dry-run, $ROOT_DOMAIN
 *     pnpm --filter @zcmsorg/database locales:enable -- --host z-cms.org
 *     pnpm --filter @zcmsorg/database locales:enable -- --slug main --locales en,vi,ja
 *     pnpm --filter @zcmsorg/database locales:enable -- --host z-cms.org --apply
 */

const db = getSystemDb();

const DEFAULT_LOCALES = ["en", "vi", "ja"];

function arg(name: string): string | undefined {
  const flag = `--${name}`;
  const i = process.argv.indexOf(flag);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  const inline = process.argv.find((a) => a.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : undefined;
}

const APPLY = process.argv.includes("--apply");

async function main() {
  const host = arg("host") ?? process.env.ROOT_DOMAIN;
  const slug = arg("slug");
  const wanted = (arg("locales") ?? DEFAULT_LOCALES.join(","))
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);

  if (!host && !slug) {
    throw new Error(
      "No site named. Pass --host <hostname> or --slug <site-slug>, or set ROOT_DOMAIN.",
    );
  }

  const site = slug
    ? await db.site.findFirst({ where: { slug } })
    : await db.site.findFirst({ where: { domains: { some: { hostname: host } } } });

  if (!site) {
    throw new Error(
      `No site found for ${slug ? `slug "${slug}"` : `hostname "${host}"`}.`,
    );
  }

  // The site's own default has to stay in the list, or every URL on it resolves to a
  // language it no longer publishes. Keep it first, then the requested order.
  const merged = [site.defaultLocale, ...wanted].filter(
    (l, i, all) => all.indexOf(l) === i,
  );

  console.log(`Site      : ${site.name} (${site.slug})  [${site.id}]`);
  console.log(`Locales   : ${site.locales.join(", ")}  ->  ${merged.join(", ")}`);
  console.log(`Default   : ${site.defaultLocale}`);
  console.log("");

  // What is missing where. Only PUBLISHED, only routable types, only real content
  // (demoThemeKey === null) — the same filters alternatesFor() uses, so this report
  // matches what the switcher will actually do once the pages exist.
  const rows = await db.content.findMany({
    where: {
      siteId: site.id,
      status: "PUBLISHED",
      demoThemeKey: null,
    },
    select: {
      translationGroupId: true,
      locale: true,
      slug: true,
      contentType: { select: { routePrefix: true, isRoutable: true } },
    },
  });

  const groups = new Map<string, { label: string; locales: Set<string> }>();
  for (const row of rows) {
    if (!row.translationGroupId || !row.contentType.isRoutable) continue;
    const id = row.translationGroupId;
    const prefix = row.contentType.routePrefix ? `/${row.contentType.routePrefix}` : "";
    const label = row.slug ? `${prefix}/${row.slug}` : prefix || "/";
    const entry = groups.get(id) ?? { label, locales: new Set<string>() };
    entry.locales.add(row.locale);
    // Prefer the default-locale slug as the group's human label when we have it.
    if (row.locale === site.defaultLocale) entry.label = label;
    groups.set(id, entry);
  }

  let missingTotal = 0;
  console.log("Translations still to author (per page, in the admin):");
  if (groups.size === 0) {
    console.log("  (no published, routable content with a translation group yet)");
  }
  for (const { label, locales } of groups.values()) {
    const missing = merged.filter((l) => !locales.has(l));
    missingTotal += missing.length;
    const status = missing.length === 0 ? "OK" : `missing: ${missing.join(", ")}`;
    console.log(`  ${label.padEnd(28)} has: ${[...locales].join(", ").padEnd(12)} ${status}`);
  }
  console.log("");

  if (!APPLY) {
    console.log("Dry run. Re-run with --apply to write Site.locales. Nothing changed.");
    return;
  }

  await db.site.update({ where: { id: site.id }, data: { locales: merged } });
  console.log(`Applied. Site.locales is now: ${merged.join(", ")}`);
  if (missingTotal > 0) {
    console.log(
      `Author the ${missingTotal} missing translation(s) above and PUBLISH them; ` +
        "the switcher appears on each page as soon as it exists in two or more locales.",
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(disconnectDb);
