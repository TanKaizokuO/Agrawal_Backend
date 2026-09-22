-- Retention purges and the pg-boss schema under the least-privilege app role.
--
-- The app role may only INSERT into restricted.* and may not DELETE from
-- processing_record, so the retention jobs cannot delete rows directly. These
-- owner-owned SECURITY DEFINER functions delete only rows whose retention has
-- expired; the app role is granted EXECUTE and nothing else.

CREATE OR REPLACE FUNCTION restricted.purge_expired()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  DELETE FROM restricted.consent_event WHERE retain_until < now();
  DELETE FROM restricted.payment WHERE retain_until < now();
  DELETE FROM restricted.refund WHERE retain_until < now();
  DELETE FROM restricted.member_tombstone WHERE retain_until < now();
$$;

REVOKE ALL ON FUNCTION restricted.purge_expired() FROM PUBLIC;

-- processing_record lives in the schema this migration runs in, so the function
-- is created there and pins that schema in its search_path.
DO $$
BEGIN
  EXECUTE format(
    $fn$
      CREATE OR REPLACE FUNCTION %1$I.purge_expired_processing_records()
      RETURNS void
      LANGUAGE sql
      SECURITY DEFINER
      SET search_path = pg_catalog, %1$I, pg_temp
      AS 'DELETE FROM %1$I.processing_record WHERE retain_until < now()'
    $fn$,
    current_schema()
  );
  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.purge_expired_processing_records() FROM PUBLIC',
    current_schema()
  );
END;
$$;

-- pg-boss runs as the app role, which has no CREATE on the database, so its
-- schema is provisioned here and the runtime starts with createSchema: false.
CREATE SCHEMA IF NOT EXISTS pgboss;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = 'agrawal_app'
  ) THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION restricted.purge_expired() TO agrawal_app';
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.purge_expired_processing_records() TO agrawal_app',
      current_schema()
    );
    EXECUTE 'GRANT USAGE, CREATE ON SCHEMA pgboss TO agrawal_app';
  END IF;
END;
$$;
