-- `@@unique([userId, siteId])` does not do what it looks like it does.
--
-- Membership.siteId is nullable, and NULL is never equal to NULL in SQL, so
-- Postgres happily accepts (user X, NULL) twice. A user could therefore
-- accumulate several tenant-wide OWNER rows — harmless-looking, but it makes
-- role revocation unreliable: deleting "the" membership leaves the others.
--
-- A partial unique index closes the hole: at most one tenant-wide membership
-- per user. The per-site case is still covered by the composite unique.
CREATE UNIQUE INDEX memberships_user_tenant_wide_key
  ON "memberships" ("user_id")
  WHERE "site_id" IS NULL;
