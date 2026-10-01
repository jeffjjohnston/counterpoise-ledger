#!/bin/bash
# Prove `ledger-cli import-postgres` on a seeded PostgreSQL database.
#
# usage: scripts/verify-postgres-conversion.sh --ref <commit> [--work-dir <dir>]
#
# <commit> is the last PostgreSQL release (or any commit before the move to
# SQLite). The script:
#
#   1. Starts a temporary PostgreSQL container and applies the Drizzle
#      migrations of <commit> with psql. It records each migration with its
#      SHA-256, as Drizzle does, so the converter accepts the source.
#   2. Builds the server and ledger-cli of <commit>, seeds the demo book,
#      imports the two Moneydance fixtures, and adds rows for the tables that
#      seed and import do not fill, and a floating investment buy. After the
#      capture of step 3, the lot of that buy gets the date of an earlier day.
#   3. Captures every GET response of every book from the PostgreSQL server.
#   4. Checks the refusals of the converter, then converts with this checkout.
#   5. Captures the same responses from this checkout's SQLite server and
#      compares them with step 3.
#
# It never touches a database other than the one in its own container. It
# needs docker, cargo, curl and python3. It exits 0 only when the conversion
# passes and no response differs.
set -euo pipefail

REF=""
WORK="${TMPDIR:-/tmp}/counterpoise-conversion-check"
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --work-dir) WORK="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$REF" ]; then
  echo "usage: $0 --ref <commit> [--work-dir <dir>]" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPARE="$ROOT/scripts/compare-api-responses.py"
OLD_TREE="$WORK/postgres-era"
OUT="$WORK/run"
CONTAINER="counterpoise-conversion-check-$$"
# The published local-dev credential: the container is temporary and listens
# on a random loopback port only.
DB_PASSWORD="counterpoise"
export TZ=America/New_York

SERVER_PIDS=()
cleanup() {
  for pid in "${SERVER_PIDS[@]:-}"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_for() {
  for _ in $(seq 1 150); do
    curl -sf "$1/api/version" >/dev/null && return 0
    sleep 0.2
  done
  echo "the server at $1 did not start" >&2
  return 1
}

echo "== build the PostgreSQL-era binaries of $REF"
COMMIT="$(git -C "$ROOT" rev-parse --verify "$REF^{commit}")"
mkdir -p "$OLD_TREE"
if [ "$(cat "$OLD_TREE/COMMIT" 2>/dev/null || true)" != "$COMMIT" ]; then
  # Keep target/ so that a second run builds incrementally.
  find "$OLD_TREE" -mindepth 1 -maxdepth 1 ! -name rust-api -exec rm -rf {} +
  find "$OLD_TREE/rust-api" -mindepth 1 -maxdepth 1 ! -name target -exec rm -rf {} + 2>/dev/null || true
  git -C "$ROOT" archive "$COMMIT" rust-api db/migrations package.json lib/api-contract.ts \
    | tar -x -C "$OLD_TREE"
  echo "$COMMIT" > "$OLD_TREE/COMMIT"
fi
(cd "$OLD_TREE/rust-api" && SQLX_OFFLINE=true cargo build -q --locked -p counterpoise-rust-api -p ledger-cli)
OLD="$OLD_TREE/rust-api/target/debug"

echo "== build this checkout"
(cd "$ROOT/rust-api" && cargo build -q --locked -p counterpoise-rust-api -p ledger-cli)
NEW="$ROOT/rust-api/target/debug"

rm -rf "$OUT"
mkdir -p "$OUT"

echo "== source database"
docker run -d --name "$CONTAINER" -e POSTGRES_USER=counterpoise -e POSTGRES_PASSWORD="$DB_PASSWORD" \
  -e POSTGRES_DB=counterpoise -p 127.0.0.1::5432 postgres:16-alpine >/dev/null
for _ in $(seq 1 150); do
  docker exec "$CONTAINER" pg_isready -q -U counterpoise -d counterpoise 2>/dev/null && break
  sleep 0.2
done
# pg_isready passes during the image's init restart; wait for a real query.
until docker exec "$CONTAINER" psql -q -U counterpoise -d counterpoise -c "SELECT 1" >/dev/null 2>&1; do
  sleep 0.2
done
PORT="$(docker port "$CONTAINER" 5432/tcp | head -1 | sed 's/.*://')"
SRC_URL="postgresql://counterpoise:counterpoise@127.0.0.1:$PORT/counterpoise"
PSQL=(docker exec -i "$CONTAINER" psql -q -v ON_ERROR_STOP=1 -U counterpoise -d counterpoise)

"${PSQL[@]}" -c "CREATE SCHEMA drizzle" \
  -c "CREATE TABLE drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)" >/dev/null
python3 - "$OLD_TREE/db/migrations" <<'PY' > "$OUT/migrations.tsv"
import json, sys
journal = json.load(open(f"{sys.argv[1]}/meta/_journal.json"))
for entry in journal["entries"]:
    print(f"{entry['tag']}\t{entry['when']}")
PY
# The list is on fd 3: `docker exec -i` reads stdin, and would eat the list.
while IFS=$'\t' read -r tag when <&3; do
  file="$OLD_TREE/db/migrations/$tag.sql"
  "${PSQL[@]}" < "$file" >/dev/null
  hash="$(shasum -a 256 "$file" | cut -d' ' -f1)"
  "${PSQL[@]}" -c "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('$hash', $when)" >/dev/null
done 3< "$OUT/migrations.tsv"
echo "applied $("${PSQL[@]}" -Atc "SELECT count(*) FROM drizzle.__drizzle_migrations" </dev/null) migrations"

echo "== seed and import with the PostgreSQL-era ledger-cli"
DATABASE_URL="$SRC_URL" "$OLD/ledger-cli" seed > "$OUT/seed.log" 2>&1
"${PSQL[@]}" -c "INSERT INTO books (user_id, name, created_at, updated_at) VALUES
  (1, 'Moneydance', now() at time zone 'utc', now() at time zone 'utc'),
  (1, 'Edge cases', now() at time zone 'utc', now() at time zone 'utc')" >/dev/null
DATABASE_URL="$SRC_URL" "$OLD/ledger-cli" import-moneydance "$ROOT/tests/fixtures/moneydance-sample.json" \
  --book-id 2 > "$OUT/import-sample.log" 2>&1
DATABASE_URL="$SRC_URL" "$OLD/ledger-cli" import-moneydance "$ROOT/tests/fixtures/moneydance-edge-cases.json" \
  --book-id 3 > "$OUT/import-edge-cases.log" 2>&1
# Rows for the tables that seed and import do not fill: non-ASCII text, jsonb
# with nested keys and nulls, fractional timestamps, and a sequence that is
# ahead of its rows.
"${PSQL[@]}" >/dev/null <<'SQL'
INSERT INTO users (username, password_hash, created_at) VALUES ('Ünïcode ✓', 'x:y', now() at time zone 'utc');
INSERT INTO book_members (book_id, user_id, role, created_at) VALUES (1, 2, 'viewer', now() at time zone 'utc');
INSERT INTO api_keys (user_id, name, key_hash, key_prefix, last_used_at, created_at)
  VALUES (1, 'MCP', 'salt:hash', 'cpk_abcd', now() at time zone 'utc', '2025-01-02 03:04:05.123456');
INSERT INTO sessions (token_hash, user_id, expires_at, created_at)
  VALUES ('deadbeef', 1, '2099-01-01 00:00:00', now() at time zone 'utc');
INSERT INTO issue_reports (user_id, description, type, page, status, created_at)
  VALUES (1, 'Café “quotes”', 'bug', '/b/1', 'new', now() at time zone 'utc');
INSERT INTO typesafe_evaluations (book_id, reconciliation_id, link_id, revision, fingerprint, attempt, snapshot,
    status, choice, probabilities, confidence, usage, answers, started_at, completed_at, latency_ms)
  VALUES (1, 1, 1, 0, 'fp1', 'a1', '{"zeta": 1, "alpha": {"b": [1, 2, {"y": null}], "a": "é"}}', 'ready',
    'candidate_1', '{"none": 0.1, "candidate_1": 0.9}', '0.9', '{"input_tokens": 10, "output_tokens": 2}',
    '{"match": "candidate_1"}', '2025-06-01 12:00:00.5', '2025-06-01 12:00:01', 500);
INSERT INTO typesafe_decisions (book_id, reconciliation_id, evaluation_id, action, transaction_id,
    suggestion_visible, accepted_suggestion, proposal_payee_kept, proposal_category_kept, active_review_ms, decided_at)
  VALUES (1, 1, 1, 'match', NULL, true, true, NULL, false, 1234, '2025-06-01 12:00:02');
INSERT INTO typesafe_quotas (book_id, day, attempts) VALUES (1, '2025-06-01', 3);
INSERT INTO typesafe_aggregates (book_id, counts) VALUES (1, '{"evaluations": 3, "odd": null, "latency_total_ms": 1.5}');
INSERT INTO payees (book_id, name, created_at) VALUES (1, 'Deleted later', now() at time zone 'utc');
DELETE FROM payees WHERE name = 'Deleted later';
UPDATE books SET typesafe_reconciliation_enabled = true WHERE id = 1;
-- A floating buy in the demo book, on a pair that the seed already holds.
DO $$
DECLARE acct integer; sec integer; cash integer; txn integer;
BEGIN
  SELECT s.account_id, s.security_id INTO acct, sec FROM investment_splits s
    WHERE s.book_id = 1 AND s.action = 'buy' ORDER BY s.id LIMIT 1;
  SELECT ts.account_id INTO cash FROM transaction_splits ts
    JOIN investment_splits s ON s.transaction_id = ts.transaction_id
    WHERE s.book_id = 1 AND s.account_id = acct AND s.security_id = sec AND ts.account_id <> acct
    ORDER BY ts.id LIMIT 1;
  INSERT INTO transactions (book_id, date, description, is_floating, created_at, updated_at)
    VALUES (1, '2025-01-03', 'Floating buy', true, now() at time zone 'utc', now() at time zone 'utc')
    RETURNING id INTO txn;
  INSERT INTO transaction_splits (book_id, transaction_id, account_id, amount)
    VALUES (1, txn, acct, 12345), (1, txn, cash, -12345);
  INSERT INTO investment_splits (book_id, transaction_id, account_id, security_id, action, shares_micros, price_micros)
    VALUES (1, txn, acct, sec, 'buy', 1000000, 123450000);
END $$;
SQL
# The lots of the floating buy, with today's date, as every write path makes them.
DATABASE_URL="$SRC_URL" "$OLD/ledger-cli" rebuild-lots --force > "$OUT/rebuild-lots.log" 2>&1
FLOATING_SECURITY="$("${PSQL[@]}" -Atc "SELECT s.security_id FROM investment_splits s
  JOIN transactions t ON t.id = s.transaction_id WHERE t.description = 'Floating buy'" </dev/null)"

echo "== capture from the PostgreSQL server"
DATABASE_URL="$SRC_URL" RUST_BIND=127.0.0.1:4901 NODE_ENV=production "$OLD/counterpoise-rust-api" \
  > "$OUT/postgres-server.log" 2>&1 &
SERVER_PIDS+=($!)
wait_for http://127.0.0.1:4901
python3 "$COMPARE" capture http://127.0.0.1:4901 "$OUT/postgres" admin password
kill "${SERVER_PIDS[0]}"

# The lot of the floating buy now holds the date of an earlier day, as when
# it was last rebuilt before today. The lots are derived state: the
# converter must rebuild that pair, not refuse the source. This comes after
# the capture, so that the responses of both servers hold today's date.
"${PSQL[@]}" -c "UPDATE investment_lots SET acquired_date = '2025-01-03'
  WHERE opened_transaction_id = (SELECT id FROM transactions WHERE description = 'Floating buy')" >/dev/null

echo "== refusals"
TARGET="$OUT/counterpoise.db"
# The edge-case book does not balance in its fixture, so the default refuses it.
if "$NEW/ledger-cli" import-postgres --from "$SRC_URL" --to "$TARGET" > "$OUT/refused-unbalanced.log" 2>&1; then
  echo "FAIL: an unbalanced source was converted without --allow-unbalanced" >&2; exit 1
fi
[ ! -e "$TARGET" ] || { echo "FAIL: a refused conversion wrote $TARGET" >&2; exit 1; }
echo "ok: an unbalanced source is refused, and no file is written"

echo "== convert"
"$NEW/ledger-cli" import-postgres --from "$SRC_URL" --to "$TARGET" --allow-unbalanced | tee "$OUT/convert.log"
[ -f "$TARGET" ] || { echo "FAIL: no converted file" >&2; exit 1; }
grep -q "rebuilt 1 pairs that have floating transactions" "$OUT/convert.log" \
  || { echo "FAIL: the converter did not report the rebuilt floating pair" >&2; exit 1; }
echo "ok: the pair with a stale floating lot is rebuilt, not refused"

if "$NEW/ledger-cli" import-postgres --from "$SRC_URL" --to "$TARGET" --allow-unbalanced > "$OUT/refused-existing.log" 2>&1; then
  echo "FAIL: an existing target was overwritten" >&2; exit 1
fi
echo "ok: an existing target is refused"
"${PSQL[@]}" -c "DELETE FROM drizzle.__drizzle_migrations WHERE id = (SELECT max(id) FROM drizzle.__drizzle_migrations)" >/dev/null
if "$NEW/ledger-cli" import-postgres --from "$SRC_URL" --to "$OUT/old-version.db" --allow-unbalanced > "$OUT/refused-old.log" 2>&1; then
  echo "FAIL: a source before the last migration was converted" >&2; exit 1
fi
echo "ok: a source before the last migration is refused"

echo "== capture from the SQLite server"
env -u DATABASE_URL DATABASE_PATH="$TARGET" RUST_BIND=127.0.0.1:4902 NODE_ENV=production "$NEW/counterpoise-rust-api" \
  > "$OUT/sqlite-server.log" 2>&1 &
SERVER_PIDS+=($!)
wait_for http://127.0.0.1:4902
python3 "$COMPARE" capture http://127.0.0.1:4902 "$OUT/sqlite" admin password
kill "${SERVER_PIDS[1]}"

echo "== compare"
# The rebuilt pair's lots have new IDs; every other value must be equal.
python3 "$COMPARE" diff "$OUT/postgres" "$OUT/sqlite" \
  --rebuilt-lots "/api/b/1/securities/$FLOATING_SECURITY/lots" > "$OUT/diff.txt" || {
  cat "$OUT/diff.txt"; echo "FAIL: responses differ; see $OUT" >&2; exit 1
}
tail -1 "$OUT/diff.txt"
echo "Conversion check passed. Output is in $OUT."
