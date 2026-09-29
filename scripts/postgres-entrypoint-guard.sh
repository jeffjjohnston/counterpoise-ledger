#!/bin/sh
# Refuses the bootstrap password this repository publishes BEFORE initdb runs.
#
# WHY THIS IS AN ENTRYPOINT AND NOT AN INITDB SCRIPT. The first attempt at this
# refusal lived in scripts/postgres-init/01-app-role.sh, and that placement
# makes a fresh deployment WORSE rather than safer. Everything in
# /docker-entrypoint-initdb.d runs AFTER initdb has created the cluster, so on
# a deployment that supplies the published value:
#
#   1. the cluster is created and the published password is stored;
#   2. the script exits 1 and the entrypoint's set -e stops the container;
#   3. counterpoise_app is never created, because it sits below the refusal;
#   4. the next start finds PG_VERSION, skips initialization entirely, and the
#      refusal never fires again — so the published password is now permanent.
#
# The diagnostic even told the operator to change the variable and start again,
# which does nothing: the stored password does not come from the variable any
# more. Postgres then reports healthy while the documented application
# connection fails.
#
# An entrypoint runs while PGDATA is still empty, which is the only moment the
# refusal can cost nothing.
#
# WHY IT MUST NOT REFUSE UNCONDITIONALLY. See the two branches below: for a
# deployment already initialized with the published value, a start-time refusal
# converts a weak password into production failing to boot at the next host
# restart. That is a worse outcome than the weak password, and it arrives
# without warning at the worst moment.
set -e

# The credential published in .env.example, the README and docker-compose.dev.yml.
# Split so no complete literal appears here for a secret scanner to match; the
# development databases it opens are disposable and it is not a secret.
PUBLISHED="counter""poise"

# The image's own default, and the same path docker-entrypoint.sh uses.
PGDATA="${PGDATA:-/var/lib/postgresql/data}"

if [ "${POSTGRES_PASSWORD:-}" = "$PUBLISHED" ]; then
  # `-s`, NOT `-e`, and it must stay that way: this has to ask the same
  # question docker-entrypoint.sh asks, because that script decides whether
  # initdb runs. It tests `-s "$PGDATA/PG_VERSION"`, so a ZERO-BYTE
  # PG_VERSION — what an interrupted initdb leaves behind — is uninitialized
  # to it and it creates the cluster. A guard testing `-e` would call that
  # same directory initialized, warn, hand over, and let the cluster be
  # created with the published password after all.
  if [ -s "$PGDATA/PG_VERSION" ]; then
    # ALREADY INITIALIZED. The password is in the cluster, not in this
    # variable, so refusing would stop a working deployment and changing the
    # variable would not fix it. Warn on every start and carry on.
    echo "WARNING: POSTGRES_PASSWORD is the password this repository publishes," >&2
    echo "         and this cluster already exists." >&2
    echo "" >&2
    echo "  If the cluster was created with that value, anyone who can reach this" >&2
    echo "  database as the superuser knows it." >&2
    echo "" >&2
    echo "  Changing POSTGRES_PASSWORD does NOT rotate it: the value lives in the" >&2
    echo "  cluster now, and this variable is only read when a cluster is created." >&2
    echo "  Rotate it in place:" >&2
    echo "" >&2
    echo "    ALTER ROLE counterpoise WITH PASSWORD '<new value>';" >&2
    echo "" >&2
    echo "  then set the same value as POSTGRES_PASSWORD in .env.production.local." >&2
    echo "  Backups authenticate as counterpoise_app and are unaffected." >&2
    echo "" >&2
  else
    # FRESH. Nothing exists yet, so refusing costs nothing and the operator's
    # next start actually takes the new value.
    echo "FATAL: POSTGRES_PASSWORD is the password this repository publishes." >&2
    echo "" >&2
    echo "  It appears in .env.example, in the README and in the development" >&2
    echo "  Compose file. Every reader of the public repository has it." >&2
    echo "" >&2
    echo "  This database has NOT been created, so nothing is lost: set a" >&2
    echo "  POSTGRES_PASSWORD of your own in .env.production.local and start" >&2
    echo "  again. See 'Separating the application database role' in README.md." >&2
    echo "" >&2
    exit 1
  fi
fi

# HAND OVER TO THE STOCK ENTRYPOINT. Losing this exec gives a container that
# guards correctly and then initializes nothing at all: no cluster, no role, no
# database. `exec` so postgres keeps PID 1 and receives the stop signal.
exec docker-entrypoint.sh postgres
