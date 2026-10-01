#!/bin/bash
# Move an install from PostgreSQL to SQLite, once. See guides/upgrade-to-sqlite.md.
#
# usage: scripts/upgrade-to-sqlite.sh [--allow-unbalanced] [--yes]
#
# Run it in the install's checkout, after you check out the first SQLite
# release and before you start that release. It:
#
#   1. checks that counterpoise_pgdata exists and that no SQLite database
#      exists yet. It refuses when a container that is not of the
#      `counterpoise` project runs on counterpoise_pgdata: a second
#      PostgreSQL on one data directory can damage it, and the script does
#      not stop a container that it does not own;
#   2. builds the new image, while the app still runs;
#   3. stops the containers of the `counterpoise` project (it does not remove
#      them), makes sure that no container runs on counterpoise_pgdata, and
#      starts the old PostgreSQL on it, in a project of its own
#      (docker-compose.upgrade.yml);
#   4. writes a pg_dump safety copy into the backups directory and checks it
#      with pg_restore --list;
#   5. creates counterpoise_data and runs `ledger-cli import-postgres` into
#      it. The converter checks every row and writes the file only when every
#      check passes. Its summary goes into the backups directory;
#   6. stops the old PostgreSQL, and makes the backups directory writable for
#      the server (uid 1000).
#
# It never deletes or changes counterpoise_pgdata. Until you delete that
# volume, the previous release still starts on it. When the script fails
# after the app stopped, it says how to start the previous release again:
# check out v1.48.0 and run `docker compose --env-file <env file> up -d --build`.
# --build is necessary: this script replaced the image of the same name.
#
# --allow-unbalanced  Convert a book whose splits do not sum to zero in
#                     PostgreSQL. Use it only after the converter refused
#                     such a book and you inspected it.
# --yes               Do not ask before the containers stop.
#
# COUNTERPOISE_PROJECT, COUNTERPOISE_PGDATA_VOLUME, COUNTERPOISE_DATA_VOLUME,
# COUNTERPOISE_ENV_FILE, COUNTERPOISE_IMAGE and UPGRADE_PROJECT exist only so
# that a rehearsal can run on throwaway volumes on a machine that also runs
# production. An install leaves them unset.
set -euo pipefail

ALLOW_UNBALANCED=""
ASSUME_YES=""
for arg in "$@"; do
  case "$arg" in
    --allow-unbalanced) ALLOW_UNBALANCED="--allow-unbalanced" ;;
    --yes) ASSUME_YES=1 ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PROJECT="${COUNTERPOISE_PROJECT:-counterpoise}"
PGDATA_VOLUME="${COUNTERPOISE_PGDATA_VOLUME:-counterpoise_pgdata}"
DATA_VOLUME="${COUNTERPOISE_DATA_VOLUME:-counterpoise_data}"
ENV_FILE="${COUNTERPOISE_ENV_FILE:-.env.production.local}"
export COUNTERPOISE_PGDATA_VOLUME="$PGDATA_VOLUME" COUNTERPOISE_DATA_VOLUME="$DATA_VOLUME" COUNTERPOISE_ENV_FILE="$ENV_FILE"
UPGRADE=(docker compose -p "${UPGRADE_PROJECT:-counterpoise-upgrade}" -f docker-compose.upgrade.yml --env-file "$ENV_FILE")
BACKUPS_DIR="${COUNTERPOISE_BACKUPS_DIR:-$ROOT/backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"

fail() { echo "Error: $*" >&2; exit 1; }

echo "==> Checks"
[ -f "$ENV_FILE" ] || fail "$ROOT/$ENV_FILE does not exist. Run this script in the install's checkout."
grep -q '^DATABASE_URL=.' "$ENV_FILE" \
  || fail "$ENV_FILE has no DATABASE_URL. The converter reads PostgreSQL with it."
[ -f docker-compose.upgrade.yml ] \
  || fail "docker-compose.upgrade.yml is missing. Check out the first SQLite release first."
docker volume inspect "$PGDATA_VOLUME" >/dev/null 2>&1 \
  || fail "the volume $PGDATA_VOLUME does not exist, so there is nothing to convert. A new install needs only: docker volume create $DATA_VOLUME"
if docker volume inspect "$DATA_VOLUME" >/dev/null 2>&1; then
  if docker run --rm -v "$DATA_VOLUME:/data" alpine:3.22 test -e /data/counterpoise.db; then
    fail "$DATA_VOLUME already holds counterpoise.db. The upgrade ran before. To convert again, move that file away first."
  fi
fi
mkdir -p "$BACKUPS_DIR"
BACKUPS_DIR="$(cd "$BACKUPS_DIR" && pwd)"
echo "backups: $BACKUPS_DIR"

UPGRADE_NAME="${UPGRADE_PROJECT:-counterpoise-upgrade}"
# The running containers of the app, and those that a failed earlier run of
# this script left in its own project.
RUNNING="$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT")"
LEFT_OVER="$(docker ps -q --filter "label=com.docker.compose.project=$UPGRADE_NAME")"
# Every running container that uses the PostgreSQL volume, whatever its
# project. A second PostgreSQL on a data directory that another PostgreSQL
# uses can damage it.
on_pgdata() { docker ps -q --no-trunc --filter "volume=$PGDATA_VOLUME"; }
# shellcheck disable=SC2086
names() { [ -z "${1// /}" ] || docker inspect --format '  {{.Name}}' $1 | sed 's#/##'; }
# shellcheck disable=SC2086
OWNED="$(docker inspect --format '{{.Id}}' $RUNNING $LEFT_OVER 2>/dev/null || true)"
ON_PGDATA="$(on_pgdata)"
FOREIGN=""
for id in $ON_PGDATA; do
  printf '%s\n' "$OWNED" | grep -qx "$id" || FOREIGN="$FOREIGN $id"
done
if [ -n "$FOREIGN" ]; then
  echo "Error: these running containers use $PGDATA_VOLUME and are not of the $PROJECT project:" >&2
  names "$FOREIGN" >&2
  fail "the script does not stop a container that it does not own, and it does not start a second PostgreSQL on $PGDATA_VOLUME. Stop them (docker stop <name>), then run this script again. Nothing changed."
fi

if [ -n "$RUNNING$LEFT_OVER" ] && [ -z "$ASSUME_YES" ]; then
  echo "These containers stop after the image build, and the app is down until you start the new release:"
  names "$RUNNING $LEFT_OVER"
  read -r -p "Continue? [y/N] " answer
  [ "$answer" = y ] || [ "$answer" = Y ] || fail "stopped; nothing changed."
fi

STOPPED=""
cleanup() {
  status=$?
  "${UPGRADE[@]}" --profile convert down >/dev/null 2>&1 || true
  if [ "$status" -ne 0 ] && [ -n "$STOPPED" ]; then
    cat >&2 <<EOT

The upgrade did not complete, and the app is stopped. $PGDATA_VOLUME is
unchanged. To start the previous release again, in $ROOT:
  git checkout v1.48.0
  docker compose --env-file $ENV_FILE up -d --build
--build is necessary: this script replaced the image of the same name with
the new release. The build takes a few minutes.
EOT
  fi
  exit "$status"
}
trap cleanup EXIT

# Before the stop: the build takes minutes, and the app runs meanwhile. A
# failed build changes nothing.
echo "==> Build the new image"
"${UPGRADE[@]}" --profile convert build convert

echo "==> Stop the running app"
STOPPED=1
if [ -n "$RUNNING$LEFT_OVER" ]; then
  # Stop, not remove. The previous release starts again with
  # `docker compose --env-file ... up -d --build` from its own checkout
  # (v1.48.0); --build, because the image above replaced its image.
  # shellcheck disable=SC2086
  docker stop $RUNNING $LEFT_OVER >/dev/null
fi

# Again, immediately before the start: nothing may run on the volume now.
STILL="$(on_pgdata)"
if [ -n "$STILL" ]; then
  echo "Error: these containers still run on $PGDATA_VOLUME:" >&2
  names "$STILL" >&2
  fail "the script does not start a second PostgreSQL on $PGDATA_VOLUME. Stop them, then run this script again."
fi

echo "==> Start PostgreSQL on $PGDATA_VOLUME"
"${UPGRADE[@]}" up -d --wait postgres

echo "==> Safety copy"
DUMP="$BACKUPS_DIR/counterpoise-pre-sqlite-$STAMP.dump"
"${UPGRADE[@]}" exec -T postgres pg_dump -U counterpoise --format=custom counterpoise > "$DUMP"
"${UPGRADE[@]}" exec -T postgres pg_restore --list < "$DUMP" >/dev/null \
  || fail "pg_restore cannot read $DUMP. Nothing was converted."
echo "wrote $DUMP ($(wc -c < "$DUMP" | tr -d ' ') bytes)"

echo "==> Convert"
docker volume create "$DATA_VOLUME" >/dev/null
SUMMARY="$BACKUPS_DIR/sqlite-conversion-$STAMP.txt"
set +e
CONVERT_FLAGS="$ALLOW_UNBALANCED" "${UPGRADE[@]}" --profile convert run --rm convert 2>&1 | tee "$SUMMARY"
STATUS=${PIPESTATUS[0]}
set -e
[ "$STATUS" -eq 0 ] || fail "the conversion did not pass (exit $STATUS). The summary is in $SUMMARY."

echo "==> Stop PostgreSQL"
"${UPGRADE[@]}" --profile convert down

echo "==> Make the backups directory writable for the server (uid 1000)"
docker run --rm -u 0 -v "$BACKUPS_DIR:/backups" alpine:3.22 \
  sh -c 'mkdir -p /backups/status && chown 1000:1000 /backups && chown -R 1000:1000 /backups/status'

cat <<EOF

The conversion passed. The summary is in $SUMMARY.
The safety copy is $DUMP.

Next:
  1. Start the new release:
       docker compose --env-file $ENV_FILE up -d --wait
     (the owner's production: run scripts/deploy.sh again).
  2. Check the app: sign in, and compare a few account balances.
  3. After a week of use, remove DATABASE_URL, POSTGRES_PASSWORD and
     APP_DB_PASSWORD from $ENV_FILE. Then remove the stopped postgres and
     scheduler containers, which still use the old volume, and delete the
     old data:
       docker compose --env-file $ENV_FILE up -d --wait --remove-orphans
       docker volume rm $PGDATA_VOLUME
EOF
