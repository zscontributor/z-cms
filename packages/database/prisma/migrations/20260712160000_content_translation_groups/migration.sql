-- Multilingual content: link the locale variants of one page together.
--
-- Every existing row becomes the sole member of its own group. That is the
-- correct reading of the world before this migration: nothing was a translation
-- of anything, because there was no way to say so.
--
-- NOT NULL with a default rather than nullable: "is this a translation of
-- something" as a nullable column means every sibling query has to handle both
-- shapes, and the null branch is the one that gets forgotten.
ALTER TABLE "contents"
  ADD COLUMN "translation_group_id" UUID NOT NULL DEFAULT gen_random_uuid();

-- A group holds at most one row per locale: a page cannot have two Vietnamese
-- translations. Enforced here rather than in the admin, which is not the only
-- thing that writes to this table.
CREATE UNIQUE INDEX "contents_site_id_translation_group_id_locale_key"
  ON "contents" ("site_id", "translation_group_id", "locale");

-- Read on every public request that resolves to content: the render path fetches
-- a page's siblings to emit hreflang and draw the language switcher.
CREATE INDEX "contents_site_id_translation_group_id_idx"
  ON "contents" ("site_id", "translation_group_id");
