#!/bin/sh
# Drop the test databases finished vitest runs left behind.
#
#   sweep-test-databases.sh
#
# Every vitest run mints its own database per worker —
# counterpoise_test_<epoch seconds>_<12 hex>_<pool> — so nothing is shared and
# nothing is reused. That is what removed the assigned-slot collision, and it is
# why this job exists: with no fixed set of names, a run has no database to hand
# back. It leaves one behind per worker and this reclaims them.
#
# TWO CONDITIONS, AND THE SECOND IS THE ONE THAT MATTERS. A candidate must be
# older than SWEEP_MIN_AGE *and* have no session connected to it. The age alone
# is not enough, and neither is the connection check alone:
#
#   - A live run's worker is not connected for every instant of its suite.
#     Between two test files it holds nothing, so a connection check on its own
#     would drop a database out from under a run that is still going.
#   - PostgreSQL refuses DROP DATABASE while any session is connected, so the
#     final guarantee is the server's, not this script's. The pg_stat_activity
#     filter only keeps the log quiet; a refusal that slips past it is counted
#     as skipped, never as a failure.
#
# THE AGE COMES OUT OF THE NAME, NOT OUT OF pg_stat_file. The first version of
# this script read a database's directory mtime through pg_stat_file, which is
# superuser-only and so refused to the role this job runs as.
# db/test-db-name.ts now puts the run's creation time in the
# name, so the age is read with an ordinary pg_database select and this job
# needs no privilege it would otherwise have had to be granted.
#
# NEVER `DROP DATABASE ... WITH (FORCE)`. FORCE terminates the sessions first,
# which turns the server's refusal into a way to destroy a running suite's
# schema — the exact defect per-run databases were introduced to end.
#
# THE PATTERN IS THE SHAPE db/test-db-name.ts BUILDS, not `counterpoise_test_%`.
# The wider prefix also matches the counterpoise_test_<slot>_<pool> databases
# the assigned-slot scheme created, which a checkout from before that change
# still uses; dropping one of those breaks an old worktree's suite instead of
# reclaiming a leak. tests/db/test-db-name.test.ts holds this pattern and the
# TypeScript one to the same shape.
#
# SWEEP_PATTERN, SWEEP_MIN_AGE and SWEEP_DRY_RUN exist so the test suite can
# reach both arms of each condition. A test narrows the pattern to its own run
# so that lowering the age cannot reach a concurrent run's databases, and it
# builds names with a chosen creation time rather than waiting for one.
# Production sets none of them.
#
# PSQL IS A TEST SEAM TOO, and a narrower one. Two arms have to put in front of
# the loop a candidate list the server will not produce — a warning psql wrote
# alongside exit 0, and a row a widened pattern let through — so those tests are
# the psql that returns it. Every arm that decides a DROP still runs against the
# real cluster, because the server's refusal is the last guarantee and only the
# server can give it.

set -u

STATUS_NAME=test-db-sweep
RECORD_STATUS="${RECORD_STATUS:-$(dirname "$0")/record-status.sh}"
PSQL="${PSQL:-psql}"

# Ten digits, twelve hex characters and a pool id, anchored at both ends.
# Anchors included: an unanchored pattern matches counterpoise_test_0_3 through
# its tail. Assigned in two steps, not as a `${SWEEP_PATTERN:-...}` default. The
# default holds `{10}`, and parameter expansion ends at the first unmatched `}`:
# the one-line form silently yields `^counterpoise_test_[0-9]{10` and PostgreSQL
# answers "invalid repetition count(s)", which reads as a bad pattern rather
# than as a truncated one.
SWEEP_PATTERN="${SWEEP_PATTERN:-}"
[ -n "$SWEEP_PATTERN" ] || SWEEP_PATTERN='^counterpoise_test_[0-9]{10}_[0-9a-f]{12}_[0-9]+$'

# WHERE THE CREATION TIME SITS IN THE NAME. Fixed here rather than taken from
# SWEEP_PATTERN, which is overridable: a widened pattern must not also widen
# what this reads as a timestamp. A name this does not match yields NULL, the
# comparison below yields NULL, and the row drops out — never selected is the
# safe direction.
SWEEP_AGE_PATTERN='^counterpoise_test_([0-9]{10})_'

# THE PREFIX THE SHELL LOOP PROVES, declared here rather than written into the
# `case` below, so tests/db/test-db-name.test.ts can read it and hold it to
# TEST_DATABASE_NAME. It is a third copy of a string that already exists in two
# places, and an unheld third copy fails in the quietest direction there is: a
# prefix that no longer matches what db/test-db-name.ts builds refuses every
# legitimate candidate, reclaims nothing, and still reports ok.
SWEEP_NAME_PREFIX='counterpoise_test_'

# TWELVE HOURS, and the length is set by what the name records. The name holds
# when the run STARTED, not when its database was last touched, so this has to
# cover the whole life of the longest plausible run rather than an idle gap
# inside one. A full local suite took 196.8s on 2026-09-09 (8 workers, 307
# files) and CI's unit-tests job is capped at 15 minutes by timeout-minutes, but
# a `vitest --watch` session held open across a working day is the long case,
# and twelve hours covers one. Err long: too short reclaims a live run's
# database, too long only lets a few more hours of finished runs accumulate, and
# the sweep runs every two hours so nothing sits far past the age. Raise it
# before lowering it.
SWEEP_MIN_AGE="${SWEEP_MIN_AGE:-12 hours}"

SWEEP_DRY_RUN="${SWEEP_DRY_RUN:-}"

# ITS OWN CONNECTION, AND NO FALLBACK TO THE SCHEDULER'S DATABASE_URL. The
# scheduler reaches the production database as `counterpoise_app`, which is
# deliberately not a superuser (guides/database-management.md) and owns nothing
# here: the test databases belong to the bootstrap role that created them, so
# DROP DATABASE is refused under it.
#
# A FALLBACK WOULD BE WORSE THAN NO CREDENTIAL. Falling back to DATABASE_URL
# gives a job that connects, lists candidates, is refused every drop, and
# reports "skipped" — a sweep that never reclaims anything and says nothing is
# wrong. An absent credential is reported as a failure instead, which is the
# whole point: the operator must set SWEEP_DATABASE_URL to
# the dedicated dev instance when running this cleanup.
SWEEP_URL="${SWEEP_DATABASE_URL:-}"

if [ -z "$SWEEP_URL" ]; then
  echo "[$STATUS_NAME] SWEEP_DATABASE_URL is unset; set it to the dedicated dev database connection"
  "$RECORD_STATUS" "$STATUS_NAME" fail "SWEEP_DATABASE_URL is unset"
  exit 1
fi

# Single quotes doubled, because both values are interpolated into SQL string
# literals below. There is no placeholder for them: the age is an interval
# constant and the pattern is the right operand of `~`.
sql_literal() {
  printf '%s' "$1" | sed "s/'/''/g"
}

CANDIDATE_SQL="
SELECT d.datname
  FROM pg_database d
 WHERE d.datname ~ '$(sql_literal "$SWEEP_PATTERN")'
   -- A name carrying no creation time gives NULL here, and NULL fails the
   -- comparison, so the row is never a candidate.
   AND to_timestamp(
         (substring(d.datname from '$(sql_literal "$SWEEP_AGE_PATTERN")'))::bigint
       ) < now() - interval '$(sql_literal "$SWEEP_MIN_AGE")'
   AND NOT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.datname = d.datname)
 ORDER BY d.datname"

# STDERR GOES TO A FILE, NOT INTO THE CANDIDATE LIST. `2>&1` here merged the two
# streams into the variable the loop below iterates as a list of database names,
# and psql writes to stderr on the SUCCESS path as well as the failing one: a
# warning alongside exit 0 turned every whitespace-separated word of that
# warning into a candidate. Measured, `WARNING:  there is no transaction in
# progress` yielded six identifier-shaped words, and the loop reached DROP
# DATABASE with each of them. A warning still has to be visible, so it is
# reported below rather than discarded — the fix is that it is reported instead
# of being read as data.
CANDIDATE_ERR="$(mktemp)"

# Tested on the assignment itself, not through `$?` afterwards: a later edit
# that puts one line between them reads the wrong command's status silently.
if ! CANDIDATES="$("$PSQL" "$SWEEP_URL" --no-psqlrc -X -q -A -t -v ON_ERROR_STOP=1 -c "$CANDIDATE_SQL" 2>"$CANDIDATE_ERR")"; then
  echo "[$STATUS_NAME] cannot list candidates: $(cat "$CANDIDATE_ERR")"
  rm -f "$CANDIDATE_ERR"
  "$RECORD_STATUS" "$STATUS_NAME" fail "cannot list candidates"
  exit 1
fi

CANDIDATE_WARNING="$(cat "$CANDIDATE_ERR")"
rm -f "$CANDIDATE_ERR"
[ -z "$CANDIDATE_WARNING" ] || echo "[$STATUS_NAME] psql warned while listing candidates: $CANDIDATE_WARNING"

DROPPED=0
SKIPPED=0

for NAME in $CANDIDATES; do
  # BOTH HALVES ARE PROVED HERE, not just the characters. The name came out of
  # pg_database and through SWEEP_PATTERN, but the pattern is overridable and
  # the prefix was enforced ONLY inside the candidate SQL — so a row that
  # reached this loop by any other route carried no prefix check at all. The
  # character class alone accepts `counterpoise` and `postgres`.
  #
  # The prefix is quoted in the pattern so it is matched as a literal; only the
  # trailing `*` is a glob.
  #
  # ORDER MATTERS: the character class is asked first, so a name with a hyphen
  # is still reported as an unexpected identifier rather than as a prefix miss.
  case "$NAME" in
    *[!a-zA-Z0-9_]*|"") REFUSAL="an unexpected database name" ;;
    "$SWEEP_NAME_PREFIX"*) REFUSAL="" ;;
    *) REFUSAL="a database name outside the $SWEEP_NAME_PREFIX prefix" ;;
  esac
  if [ -n "$REFUSAL" ]; then
    echo "[$STATUS_NAME] refusing $REFUSAL"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi
  if [ -n "$SWEEP_DRY_RUN" ]; then
    echo "[$STATUS_NAME] would drop $NAME"
    DROPPED=$((DROPPED + 1))
    continue
  fi
  if OUT="$("$PSQL" "$SWEEP_URL" --no-psqlrc -X -q -A -t -v ON_ERROR_STOP=1 \
      -c "DROP DATABASE \"$NAME\"" 2>&1)"; then
    echo "[$STATUS_NAME] dropped $NAME"
    DROPPED=$((DROPPED + 1))
  else
    # Almost always a session that connected after the query above. The
    # database is in use, which is the one outcome that must never be forced.
    echo "[$STATUS_NAME] skipped $NAME: $OUT"
    SKIPPED=$((SKIPPED + 1))
  fi
done

# A dry run says so. Recording "dropped N" for a run that dropped nothing puts
# a false count in the status file every reader treats as a record of work done.
if [ -n "$SWEEP_DRY_RUN" ]; then
  SUMMARY="dry run, $DROPPED would be dropped, skipped $SKIPPED"
else
  SUMMARY="dropped $DROPPED, skipped $SKIPPED"
fi
"$RECORD_STATUS" "$STATUS_NAME" ok "$SUMMARY"
echo "[$STATUS_NAME] $SUMMARY"
exit 0
