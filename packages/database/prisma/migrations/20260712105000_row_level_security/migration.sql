-- Row-Level Security for Z-CMS.
--
-- This is the last line of defence for tenant isolation. Application code is
-- still expected to filter by tenant, but if a developer forgets a
-- `where: { tenantId }` clause the database refuses to return the rows anyway.
--
-- How it works together with packages/database/src/tenant-context.ts:
--
--   1. cms-api connects as `zcms_app` (NOBYPASSRLS, owns no tables).
--   2. withTenant() opens a transaction and runs
--        SELECT set_config('app.tenant_id', '<uuid>', true)
--      binding the tenant to that connection for that transaction only.
--   3. Every policy below compares the row's tenant_id against that setting.
--
-- The `NULLIF(..., '')` guard matters: current_setting(..., true) returns an
-- empty string when the variable was never set. Casting '' to uuid raises, so
-- we normalise it to NULL, which makes the comparison false and the query
-- return zero rows. Failing closed is the point — a query with no tenant
-- context must see nothing, never everything.

CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

-- The tenant row itself is keyed on `id`, not `tenant_id`.
ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tenants"
  USING ("id" = current_tenant_id())
  WITH CHECK ("id" = current_tenant_id());

-- Every other tenant-scoped table follows the same shape. Looping over the
-- catalog keeps the policy identical everywhere; a hand-written list is exactly
-- where a table gets forgotten.
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND a.attname = 'tenant_id'
      AND NOT a.attisdropped
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      'USING (tenant_id = current_tenant_id()) '
      'WITH CHECK (tenant_id = current_tenant_id())', t);
  END LOOP;
END
$$;

-- The runtime role must be able to read and write, but never to alter policies
-- or create tables. It owns nothing, so it cannot disable RLS on its own rows.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO zcms_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO zcms_app;
GRANT EXECUTE ON FUNCTION current_tenant_id() TO zcms_app;

-- Platform catalog tables are shared across tenants by design: every tenant
-- browses the same theme and plugin marketplace. They carry no tenant_id and
-- therefore no policy, but the app role gets read-only access — installing a
-- theme writes to site_themes (which IS tenant-scoped), never to the catalog.
REVOKE INSERT, UPDATE, DELETE ON "themes", "theme_versions", "plugins", "plugin_versions"
  FROM zcms_app;
