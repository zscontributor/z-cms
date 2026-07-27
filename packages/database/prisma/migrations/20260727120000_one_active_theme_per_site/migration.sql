-- Exactly one ACTIVE theme per site — the invariant the application always assumed
-- but the schema never enforced.
--
-- SiteTheme only had `@@unique([siteId, themeId])`, so a site could hold several
-- rows with status = 'ACTIVE' at once. The seed exploited this by accident: it
-- upserted the default theme with `status: ACTIVE` on every re-seed without first
-- deactivating the site's real theme, leaving both ACTIVE. The render read the
-- active theme with an unordered `findFirst({ status: ACTIVE })`, so Postgres was
-- free to return either row — and the site flipped to the default theme after a
-- deploy that ran the seed.
--
-- First heal the data, then close the hole with a partial unique index.

-- 1. Where a real (non-default) theme is ACTIVE on a site, an ACTIVE default row is
--    the stray one the old seed left behind — stand it down.
UPDATE "site_themes" st
SET "status" = 'INACTIVE', "updated_at" = now()
FROM "themes" t
WHERE st."theme_id" = t."id"
  AND t."key" = 'vn.zsoft.theme.default'
  AND st."status" = 'ACTIVE'
  AND EXISTS (
    SELECT 1
    FROM "site_themes" other
    JOIN "themes" ot ON ot."id" = other."theme_id"
    WHERE other."site_id" = st."site_id"
      AND other."status" = 'ACTIVE'
      AND ot."key" <> 'vn.zsoft.theme.default'
  );

-- 2. Belt and braces: if any site still has more than one ACTIVE theme (e.g. two
--    non-default rows), keep the most recently updated and deactivate the rest so
--    the unique index below can be created.
UPDATE "site_themes"
SET "status" = 'INACTIVE', "updated_at" = now()
WHERE "id" IN (
  SELECT "id"
  FROM (
    SELECT "id",
           row_number() OVER (
             PARTITION BY "site_id"
             ORDER BY "updated_at" DESC, "id"
           ) AS rn
    FROM "site_themes"
    WHERE "status" = 'ACTIVE'
  ) ranked
  WHERE ranked.rn > 1
);

-- 3. The guarantee: at most one ACTIVE theme per site, enforced by the database.
CREATE UNIQUE INDEX "site_themes_one_active_per_site_key"
  ON "site_themes" ("site_id")
  WHERE "status" = 'ACTIVE'::"InstallStatus";
