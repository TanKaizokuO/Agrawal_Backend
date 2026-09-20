#!/usr/bin/env bash
# apps/api/deploy/postgres-init.sh
# Initializes local PostgreSQL with the same role model used in production.
set -euo pipefail

: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${APP_DB_USER:?APP_DB_USER is required}"
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD is required}"

echo "Initializing database: ${POSTGRES_DB}..."

psql \
  -v ON_ERROR_STOP=1 \
  -v db_name="${POSTGRES_DB}" \
  -v app_db_user="${APP_DB_USER}" \
  -v app_db_password="${APP_DB_PASSWORD}" \
  --username "${POSTGRES_USER}" \
  --dbname "${POSTGRES_DB}" <<-'EOSQL'
  -- Required extensions per docs/backend/architecture.md
  CREATE EXTENSION IF NOT EXISTS "pg_trgm";
  CREATE EXTENSION IF NOT EXISTS "citext";
  SELECT set_config('app.bootstrap_db_name', :'db_name', false);
  SELECT set_config('app.bootstrap_app_user', :'app_db_user', false);
  SELECT set_config('app.bootstrap_app_password', :'app_db_password', false);


  -- Create the application role without interpolating an identifier or secret
  -- into SQL text. Prisma migrations run later as the owner role.
  DO $create_role$
  DECLARE
    app_user text := current_setting('app.bootstrap_app_user');
    app_password text := current_setting('app.bootstrap_app_password');
  BEGIN
    IF NOT EXISTS (
      SELECT FROM pg_catalog.pg_roles WHERE rolname = app_user
    ) THEN
      EXECUTE format('CREATE ROLE %I WITH LOGIN PASSWORD %L', app_user, app_password);
    END IF;
  END
  $create_role$;

  -- The migration creates restricted tables after this bootstrap script. The
  -- schema and its default are created here so rerunning local bootstrap has
  -- the same future-object privileges as production provisioning.
  CREATE SCHEMA IF NOT EXISTS restricted;

  DO $grant_app$
  DECLARE
    app_user text := current_setting('app.bootstrap_app_user');
    database_name text := current_setting('app.bootstrap_db_name');
  BEGIN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', database_name, app_user);
    EXECUTE format('GRANT USAGE, CREATE ON SCHEMA public TO %I', app_user);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', app_user);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', app_user);
    EXECUTE format('GRANT USAGE ON SCHEMA restricted TO %I', app_user);

    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', app_user);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I', app_user);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA restricted REVOKE ALL ON TABLES FROM %I', app_user);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA restricted GRANT INSERT ON TABLES TO %I', app_user);

    IF to_regclass('public.processing_record') IS NOT NULL THEN
      EXECUTE format('GRANT SELECT, INSERT ON TABLE public.processing_record TO %I', app_user);
      EXECUTE format('REVOKE UPDATE, DELETE ON TABLE public.processing_record FROM %I', app_user);
    END IF;
  END
  $grant_app$;
EOSQL

echo "Database ${POSTGRES_DB} initialization complete."
