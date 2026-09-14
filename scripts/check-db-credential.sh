#!/bin/sh
# Refuses to start when DATABASE_URL is absent, or when it carries the
# credential this repository publishes as its local-development default.
#
# WHERE IT RUNS. In both containers that carry DATABASE_URL: the app, from
# docker-entrypoint.sh, which the image holds; and the scheduler, which runs
# the stock postgres image and therefore reads the script through a bind mount
# declared in docker-compose.yml.
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
# `down`, so local development and routine operations all break with it. An
# entrypoint reaches only the container that is starting, so it leaves those
# operations alone.
#
# It also checks the connection string itself rather than a stand-in variable,
# so it still fires for an operator who sets APP_DB_PASSWORD and then forgets
# to point DATABASE_URL at the new role.
set -e

# AN UNSET OR EMPTY DATABASE_URL IS A REFUSAL, AND IT DID NOT USED TO BE.
#
# The comment that stood here said "Unset is not this check's business. The app
# fails later with a connection error, which is already clear." That premise
# was wrong, and this refusal replaces it.
#
# With no DATABASE_URL the app connects to 127.0.0.1:5432 INSIDE ITS OWN
# CONTAINER and crash-loops. No message names the missing file, so the cause
# is invisible. The connection error is not clear; it points at a host nobody
# configured.
#
# COMPOSE NOW REFUSES A MISSING FILE, AND THIS STILL HAS WORK TO DO.
# docker-compose.yml declares .env.production.local with `required: true`, so an
# absent file stops the command before any container is recreated. That closes
# the missing-file case, and it closes nothing else: a file that
# EXISTS and sets no DATABASE_URL, or sets it empty, satisfies Compose and
# reaches here. So does an operator who edits the file to a blank value.
#
# THE TWO GUARDS ANSWER DIFFERENT QUESTIONS, in that order. Compose asks
# "is the file there"; this asks "did it give me a credential". Neither makes
# the other redundant.
#
# EMPTY COUNTS AS UNSET. An env_file line with nothing after the `=` sets the
# variable to an empty string, and an empty connection string opens nothing.
# `[ -n ... ]` is the question; a test for definition alone permits that input.
if [ -z "${DATABASE_URL:-}" ]; then
  echo "FATAL: DATABASE_URL is not set." >&2
  echo "" >&2
  echo "  expected from: .env.production.local" >&2
  echo "" >&2
  echo "That file is a required env_file, so it was read. It set no" >&2
  echo "DATABASE_URL, or set it empty. With no DATABASE_URL this application" >&2
  echo "connects to 127.0.0.1:5432 inside its own container and crash-loops." >&2
  echo "That is how a deployment goes down." >&2
  echo "" >&2
  echo "Set DATABASE_URL in it — see .env.example — and run Compose from the" >&2
  echo "checkout root that holds it." >&2
  exit 1
fi

case "$DATABASE_URL" in
*counterpoise:counterpoise@*)
  echo "FATAL: DATABASE_URL uses the published default database credential." >&2
  echo "" >&2
  echo "This password is published in .env.example and the README. Anyone who" >&2
  echo "can reach this database can read every account, balance and payee in it." >&2
  echo "" >&2
  echo "Create a role for the application and point DATABASE_URL at it." >&2
  echo "See 'Separating the application database role' in README.md." >&2
  exit 1
  ;;
esac
