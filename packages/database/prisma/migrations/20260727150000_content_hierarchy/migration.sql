-- WordPress-style hierarchical pages: a content row can have a parent, so a page
-- "product" with child "zpets" is served at /product/zpets (with the locale prefix,
-- /ja/product/zpets).
--
-- Routing moves from "content type route prefix + flat slug" to a materialized,
-- locale-relative `path` per row. The router then resolves a request with a single
-- indexed lookup on (site, locale, path) instead of splitting the URL and guessing
-- which leading segments are a route prefix.
--
-- Order matters: add the columns, backfill `path` for the existing (all top-level)
-- rows, THEN swap the uniqueness from slug to path — the unique index would reject
-- the backfill if created first.

-- 1. New columns. `path` is nullable for now so existing rows can be backfilled;
--    `parent_id` is a self-FK, Restrict on delete (a page with children cannot be
--    deleted until they are moved or removed).
ALTER TABLE "contents" ADD COLUMN "path" TEXT;
ALTER TABLE "contents" ADD COLUMN "parent_id" UUID;

-- 2. Backfill. Every existing row is top-level, so its path is exactly what the
--    old code derived at read time: "/{route_prefix}/{slug}", collapsing the empty
--    slug (a homepage) to "/{route_prefix}" or "/".
UPDATE "contents" c
SET "path" = CASE
  WHEN c."slug" = '' THEN
    CASE WHEN ct."route_prefix" = '' THEN '/' ELSE '/' || ct."route_prefix" END
  WHEN ct."route_prefix" = '' THEN '/' || c."slug"
  ELSE '/' || ct."route_prefix" || '/' || c."slug"
END
FROM "content_types" ct
WHERE ct."id" = c."content_type_id";

-- 3. Path is required from here on.
ALTER TABLE "contents" ALTER COLUMN "path" SET NOT NULL;
ALTER TABLE "contents" ALTER COLUMN "path" SET DEFAULT '/';

-- 4. Swap the routing uniqueness: the path is now the unique routing key per
--    site + locale (sibling slug-uniqueness follows from it). Drop the old slug one.
--    COALESCE mirrors the existing demo-theme index: two rows with the same
--    (site, locale, path) and NO demo theme must still conflict — plain Postgres
--    treats NULLs as distinct, which would let duplicates through.
DROP INDEX "contents_site_id_locale_slug_demo_theme_key_key";
CREATE UNIQUE INDEX "contents_site_id_locale_path_demo_theme_key_key"
  ON "contents" ("site_id", "locale", "path", COALESCE("demo_theme_key", ''));

-- 5. Parent self-relation + the index that backs the parent picker and the
--    descendant-path cascade.
ALTER TABLE "contents"
  ADD CONSTRAINT "contents_parent_id_fkey"
  FOREIGN KEY ("parent_id") REFERENCES "contents"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "contents_site_id_parent_id_idx" ON "contents" ("site_id", "parent_id");
