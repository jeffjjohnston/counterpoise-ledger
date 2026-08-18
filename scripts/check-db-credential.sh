#!/bin/sh
# Refuses to start when DATABASE_URL carries the credential this repository
# publishes as its local-development default.
#
# That credential is not a secret and is not meant to be one. It appears in
# .env.example, in the README, and hardcoded in four development and test
# entry points, because the databases it opens are disposable. A production
# deployment that keeps it has a password every reader of the public
# repository already knows.
#
# WHY HERE AND NOT IN docker-compose.yml
#
# A `${APP_DB_PASSWORD:?...}` guard on the app service does fail closed, but
# Compose interpolates the whole file before it selects services. Measured:
# the guard also blocks `docker compose up -d postgres`, `ps`, `logs` and
# `down`, so local development and routine operations all break with it. The
# entrypoint reaches only the container whose credential is at stake.
#
# It also checks the connection string itself rather than a stand-in variable,
# so it still fires for an operator who sets APP_DB_PASSWORD and then forgets
# to point DATABASE_URL at the new role.
set -e

# Unset is not this check's business. The app fails later with a connection
# error, which is already clear, and refusing here would break `docker compose`
# runs that deliberately supply no env_file.
[ -n "${DATABASE_URL:-}" ] || exit 0

case "$DATABASE_URL" in
*counterpoise:counterpoise@*)
  echo "FATAL: DATABASE_URL uses the published default database credential." >&2
  echo "" >&2
  echo "This password is published in .env.example and the README. Anyone who" >&2
  echo "can reach this database can read every account, balance and payee in it." >&2
  echo "" >&2
  echo "Create a role for the application and point DATABASE_URL at it." >&2
  echo "See 'Separating the application database role' in the README." >&2
  exit 1
  ;;
esac
