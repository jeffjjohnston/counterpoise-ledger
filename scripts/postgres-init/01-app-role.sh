#!/bin/bash
# Creates a dedicated role for the application, owning the application
# database. Runs from /docker-entrypoint-initdb.d on FIRST initialization
# only — the postgres image skips this directory entirely once PGDATA holds a
# database ("Skipping initialization" in the log).
#
# Existing deployments therefore do not get a role from this script. Migrating
# one is a documented manual step; see "Separating the application database
# role" in the README.
#
# Two things are separated here, not one:
#
#   - The password. POSTGRES_PASSWORD belongs to the bootstrap superuser and
#     defaults to a value this repository publishes, because the development
#     and test databases on the same instance hardcode it in four places and
#     are disposable. Production gets its own password instead of inheriting
#     that one.
#
#   - The privileges. The bootstrap role is a superuser. The application only
#     ever runs plain DDL and DML — no CREATE EXTENSION, no role management —
#     so it has no need of that, and an owner role is enough to run migrations.
set -e

if [ -z "${APP_DB_PASSWORD:-}" ]; then
  echo "app-role: APP_DB_PASSWORD is unset; not creating an application role."
  echo "app-role: fine for local development. For a deployment, see the README."
  exit 0
fi

# psql's :'var' and :"var" render a quoted literal and a quoted identifier
# respectively, so the password and database name are never pasted into SQL
# text by the shell.
psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  -v app_password="$APP_DB_PASSWORD" \
  -v db="$POSTGRES_DB" <<'SQL'
CREATE ROLE counterpoise_app LOGIN PASSWORD :'app_password';

-- Ownership, not GRANTs. The application runs its own migrations at startup,
-- so it must be able to create and alter tables, and owning the database and
-- the schema it builds in is the least tangled way to allow exactly that.
ALTER DATABASE :"db" OWNER TO counterpoise_app;
ALTER SCHEMA public OWNER TO counterpoise_app;
SQL

echo "app-role: created counterpoise_app and gave it ownership of $POSTGRES_DB"
