-- Z-CMS bootstraps TWO Postgres roles, and the split is what makes Row-Level
-- Security actually enforceable:
--
--   zcms      (owner)  - owns every table, runs migrations and seeds.
--                        A table owner is NOT subject to its own RLS policies
--                        unless FORCE is set, so this role can move freely.
--                        Used by the "system" client for cross-tenant work
--                        (login by email, domain -> site resolution).
--
--   zcms_app  (runtime) - owns nothing. Every request from cms-api uses this
--                        role, so RLS policies are always applied. Even a query
--                        where a developer forgot `where: { tenantId }` cannot
--                        leak another tenant's rows.
--
-- If the API ever connects as `zcms`, tenant isolation silently disappears.
-- That is the single most important invariant in this file.

CREATE ROLE zcms_app WITH LOGIN PASSWORD 'zcms_app' NOBYPASSRLS;

GRANT CONNECT ON DATABASE zcms TO zcms_app;
GRANT USAGE ON SCHEMA public TO zcms_app;

-- Rights on tables that already exist (none yet at init time, but harmless).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO zcms_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO zcms_app;

-- Rights on tables created later by migrations run as `zcms`.
ALTER DEFAULT PRIVILEGES FOR ROLE zcms IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO zcms_app;
ALTER DEFAULT PRIVILEGES FOR ROLE zcms IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO zcms_app;

-- The app role must never be able to turn policies off.
REVOKE CREATE ON SCHEMA public FROM zcms_app;
