import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSystemDb, withTenant, db } from "@zcmsorg/database";
import type { JobPayloads } from "@zcmsorg/queue";

/**
 * Rebuilds a site's sitemap.xml from its published content.
 *
 * A first-party job, so it reads content directly — but through `withTenant`,
 * because it touches tenant tables and RLS applies to the worker's connection
 * just as it does to the API's. The verified tenant id comes from the job
 * payload, which cms-api stamped when it enqueued.
 */
export async function runSitemap(
  data: JobPayloads["site.sitemap"],
): Promise<{ urls: number }> {
  const site = await getSystemDb().site.findFirst({
    where: { id: data.siteId, tenantId: data.tenantId },
    include: { domains: { where: { isPrimary: true }, take: 1 } },
  });
  if (!site) return { urls: 0 };

  const host = site.domains[0]?.hostname ?? "";
  const origin = host.startsWith("localhost") ? `http://${host}` : `https://${host}`;

  const rows = await withTenant(data.tenantId, () =>
    db().content.findMany({
      where: {
        siteId: data.siteId,
        status: "PUBLISHED",
        // A locale the site no longer publishes in still has rows. They are not
        // reachable — the router will not resolve a prefix that is not in
        // `site.locales` — so listing them would be advertising 404s.
        locale: { in: site.locales },
      },
      include: { contentType: { select: { routePrefix: true, isRoutable: true } } },
      orderBy: { publishedAt: "desc" },
      take: 50_000,
    }),
  );

  const routable = rows.filter((r) => r.contentType.isRoutable);

  /**
   * The public URL of a row. The default locale is served unprefixed; every other
   * locale carries its code — the same rule the router applies in reverse.
   *
   * This used to ignore the locale entirely, which was harmless while every site
   * was monolingual and wrong the moment one was not: a Vietnamese page slugged
   * "gioi-thieu" was submitted to search engines as "/gioi-thieu", a URL that
   * resolves to nothing. It lives at "/vi/gioi-thieu".
   */
  const locate = (r: (typeof routable)[number]): string => {
    const prefix = r.contentType.routePrefix ? `/${r.contentType.routePrefix}` : "";
    const path = r.slug ? `${prefix}/${r.slug}` : prefix || "/";
    const locale = r.locale === site.defaultLocale ? "" : `/${r.locale}`;
    const joined = `${locale}${path}`.replace(/\/{2,}/g, "/");
    return joined.length > 1 ? joined.replace(/\/$/, "") : joined || "/";
  };

  // Siblings, so each <url> can declare the others. Search engines treat a set of
  // translations as one page only when every member points at every other member
  // *including itself* — a one-way hreflang is ignored.
  const byGroup = new Map<string, typeof routable>();
  for (const row of routable) {
    const group = byGroup.get(row.translationGroupId) ?? [];
    group.push(row);
    byGroup.set(row.translationGroupId, group);
  }

  const urls = routable.map((r) => {
    const lastmod = (r.publishedAt ?? r.updatedAt).toISOString();
    const siblings = byGroup.get(r.translationGroupId) ?? [r];

    const links =
      siblings.length > 1
        ? siblings
            .map(
              (s) =>
                `\n    <xhtml:link rel="alternate" hreflang="${s.locale}" href="${origin}${locate(s)}"/>`,
            )
            .join("")
        : "";

    return `  <url><loc>${origin}${locate(r)}</loc><lastmod>${lastmod}</lastmod>${links}\n  </url>`;
  });

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"` +
    ` xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join("\n")}\n</urlset>\n`;

  const client = new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION ?? "us-east-1",
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY!,
      secretAccessKey: process.env.S3_SECRET_KEY!,
    },
    forcePathStyle: true,
  });

  await client.send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET!,
      Key: `sites/${data.siteId}/sitemap.xml`,
      Body: xml,
      ContentType: "application/xml",
    }),
  );

  return { urls: urls.length };
}
