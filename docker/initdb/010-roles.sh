#!/usr/bin/env bash
# Bonfire DB initdb: pgvector extension + the two-role model (BF-01).
#
# Runs once on first boot of the db container (docker-entrypoint-initdb.d) as
# the Postgres superuser. Creates the RUNTIME role `bonfire_app`:
#   LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION NOINHERIT
# so Row-Level Security can never be silently bypassed. Migrations run as the
# superuser/owner (a deploy step, see `bun run db:migrate`); the application
# only ever connects as bonfire_app.
#
# The password is bound as a psql variable (-v), never string-interpolated into
# SQL. The whole body runs in a subshell so `set -euo pipefail` is safe whether
# the entrypoint executes this file or sources it (non-executable bit).
(
  set -euo pipefail

  psql -v ON_ERROR_STOP=1 \
    -v app_password="$APP_DB_PASSWORD" \
    --username "$POSTGRES_USER" \
    --dbname "$POSTGRES_DB" <<'SQL'
CREATE EXTENSION IF NOT EXISTS vector;

CREATE ROLE bonfire_app
  LOGIN
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOBYPASSRLS
  NOREPLICATION
  NOINHERIT
  PASSWORD :'app_password';

-- Default-deny schema access: only what bonfire_app needs, nothing for PUBLIC.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO bonfire_app;

-- Tables/sequences created later by migrations (as postgres, the owner) are
-- readable/writable by the app role — DML only, never DDL, never ownership.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bonfire_app;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO bonfire_app;
SQL
)
