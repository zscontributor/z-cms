-- Theme-owned demo data.
--
-- Normal site data has demo_theme_key = NULL and behaves as it always has.
-- Demo rows carry the theme key that created them; the render path reads those
-- rows only while that theme is active. This lets a site seed sample pages for
-- several themes without one theme's demo homepage shadowing another's.

ALTER TABLE "contents"
  ADD COLUMN "demo_theme_key" TEXT;

ALTER TABLE "menus"
  ADD COLUMN "demo_theme_key" TEXT;

DROP INDEX "contents_site_id_locale_slug_key";
CREATE UNIQUE INDEX "contents_site_id_locale_slug_demo_theme_key_key"
  ON "contents" ("site_id", "locale", "slug", COALESCE("demo_theme_key", ''));

DROP INDEX "menus_site_id_key_key";
CREATE UNIQUE INDEX "menus_site_id_key_demo_theme_key_key"
  ON "menus" ("site_id", "key", COALESCE("demo_theme_key", ''));

CREATE INDEX "contents_site_id_demo_theme_key_idx"
  ON "contents" ("site_id", "demo_theme_key");

CREATE INDEX "menus_site_id_demo_theme_key_idx"
  ON "menus" ("site_id", "demo_theme_key");
