-- ==============================================================================
-- Agrawal Samaj - RDS PostgreSQL 18 Bootstrap Script
--
-- References:
--   - deploy/README.md §5 (Database Role Verification)
--   - deploy/postgres-init.sh (Role model and privileges)
--   - ADR-0029 (PostgreSQL 18)
--   - Security Invariant: Never use master 'postgres' role for application runtime.
--
-- Usage:
--   PGPASSWORD="<DB_MASTER_PASSWORD>" psql \
--     -h "<RDS_ENDPOINT_HOST>" \
--     -p 5432 \
--     -U postgres \
--     -d "<DB_NAME>" \
--     -v ON_ERROR_STOP=1 \
--     -v app_password="'<APP_DB_PASSWORD>'" \
--     -v owner_password="'<MIGRATION_DB_PASSWORD>'" \
--     -v db_name="<DB_NAME>" \
--     -f rds-bootstrap.sql
-- ==============================================================================

\set ON_ERROR_STOP on

-- 1. Install required extensions per docs/backend/architecture.md & ADR-0029
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "citext";
CREATE EXTENSION IF NOT EXISTS "unaccent";

-- 2. Create restricted schema for statutory retention and audit records
CREATE SCHEMA IF NOT EXISTS restricted;

-- 3. Create migration owner role (agrawal_owner)
-- Used exclusively by 'npx prisma migrate deploy'
DO $create_owner$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'agrawal_owner') THEN
    EXECUTE format('CREATE ROLE agrawal_owner WITH LOGIN PASSWORD %s', :owner_password);
  ELSE
    EXECUTE format('ALTER ROLE agrawal_owner WITH PASSWORD %s', :owner_password);
  END IF;
END
$create_owner$;

-- 4. Create least-privilege runtime application role (agrawal_app)
-- Used exclusively by Express API container (DATABASE_URL)
DO $create_app$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'agrawal_app') THEN
    EXECUTE format('CREATE ROLE agrawal_app WITH LOGIN PASSWORD %s', :app_password);
  ELSE
    EXECUTE format('ALTER ROLE agrawal_app WITH PASSWORD %s', :app_password);
  END IF;
END
$create_app$;

-- 5. Assign schema ownership to migration owner
ALTER SCHEMA public OWNER TO agrawal_owner;
ALTER SCHEMA restricted OWNER TO agrawal_owner;

-- 6. Grant connection and schema privileges
GRANT CONNECT ON DATABASE :"db_name" TO agrawal_owner;
GRANT CONNECT ON DATABASE :"db_name" TO agrawal_app;

GRANT ALL PRIVILEGES ON SCHEMA public TO agrawal_owner;
GRANT ALL PRIVILEGES ON SCHEMA restricted TO agrawal_owner;

-- Application role privileges on public schema
GRANT USAGE, CREATE ON SCHEMA public TO agrawal_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO agrawal_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO agrawal_app;

-- Application role privileges on restricted schema
GRANT USAGE ON SCHEMA restricted TO agrawal_app;

-- 7. Configure default privileges for future objects created by migration owner
ALTER DEFAULT PRIVILEGES FOR ROLE agrawal_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO agrawal_app;

ALTER DEFAULT PRIVILEGES FOR ROLE agrawal_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO agrawal_app;

ALTER DEFAULT PRIVILEGES FOR ROLE agrawal_owner IN SCHEMA restricted
  REVOKE ALL ON TABLES FROM agrawal_app;

ALTER DEFAULT PRIVILEGES FOR ROLE agrawal_owner IN SCHEMA restricted
  GRANT INSERT ON TABLES TO agrawal_app;

-- 8. Apply table-level restrictions if tables already exist
DO $apply_table_restrictions$
BEGIN
  -- Restricted tables: INSERT ONLY for statutory retention
  IF to_regclass('restricted.member_tombstone') IS NOT NULL THEN
    REVOKE ALL ON TABLE restricted.member_tombstone FROM agrawal_app;
    GRANT INSERT ON TABLE restricted.member_tombstone TO agrawal_app;
  END IF;

  IF to_regclass('restricted.payment') IS NOT NULL THEN
    REVOKE ALL ON TABLE restricted.payment FROM agrawal_app;
    GRANT INSERT ON TABLE restricted.payment TO agrawal_app;
  END IF;

  IF to_regclass('restricted.refund') IS NOT NULL THEN
    REVOKE ALL ON TABLE restricted.refund FROM agrawal_app;
    GRANT INSERT ON TABLE restricted.refund TO agrawal_app;
  END IF;

  IF to_regclass('restricted.consent_event') IS NOT NULL THEN
    REVOKE ALL ON TABLE restricted.consent_event FROM agrawal_app;
    GRANT INSERT ON TABLE restricted.consent_event TO agrawal_app;
  END IF;

  -- Processing records: Append-only audit log (SELECT, INSERT allowed; UPDATE, DELETE prohibited)
  IF to_regclass('public.processing_record') IS NOT NULL THEN
    GRANT SELECT, INSERT ON TABLE public.processing_record TO agrawal_app;
    REVOKE UPDATE, DELETE ON TABLE public.processing_record FROM agrawal_app;
  END IF;
END
$apply_table_restrictions$;

-- 9. Confirmation query
SELECT
  r.rolname,
  r.rolcanlogin,
  d.datname
FROM pg_roles r
CROSS JOIN pg_database d
WHERE r.rolname IN ('postgres', 'agrawal_owner', 'agrawal_app')
  AND d.datname = :'db_name';
