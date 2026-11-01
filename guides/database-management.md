# Database Management

One of the guides [CLAUDE.md](../CLAUDE.md) points to. Read that file first;
it carries the rules that apply everywhere and says when to come here.

## The database

Counterpoise keeps all data in one SQLite file. `DATABASE_PATH` names it:

| Where | Default |
| --- | --- |
| Docker image | `/data/counterpoise.db`, on the volume `counterpoise_data` |
| Worker | no file: the Durable Object's own storage (see [Production data on the Worker](#production-data-on-the-worker)) |
| Development (`cargo run`, `ledger-cli`) | `data/counterpoise.db`, relative to the working directory |
| E2E tests | `.e2e/counterpoise.db` |
| Vitest | one file per worker; see [testing.md](testing.md) |

These files sit beside the database:

- `counterpoise.db-wal` and `counterpoise.db-shm`: the write-ahead log. They
  are part of the database while a process has it open. Do not copy the
  `.db` file alone while the server runs. Use a snapshot (see below).
- `counterpoise.db.lock`: the server lock. The server takes it at startup.
  A second server on the same file refuses to start. `ledger-cli migrate` and
  `ledger-cli seed --reset` also refuse while a server holds it.

Usage: `ledger-cli seed [--book-id N | --reset] [--dataset household|single]
[--today YYYY-MM-DD]`. The dates end today in the app's `TZ`; `--today`
pins them. `--today 2025-12-31` gives the 2023-2025 household rows (2,235
transactions). The count depends on `today`.

Each connection sets `journal_mode=WAL`, `foreign_keys=ON`,
`busy_timeout=5000`, `synchronous=FULL` and `mmap_size` (256 MB,
`MMAP_SIZE` in `rust-api/db/src/database.rs`). A test asserts them on a
connection that `Database::open` opened.

`synchronous=FULL` syncs the WAL to the disk at each commit, before the
commit returns. With `NORMAL` and WAL, a commit that returned can be lost
when the power fails or the machine (or the Docker VM) stops. A lost commit
is a lost transaction in the ledger. Do not change it to `NORMAL` for speed.
The server, `ledger-cli` and the tests all open the file with
`ledger_db::Database::open`, so they all get this setting.

The memory map is for speed. Without it, each connection copies the pages
that it reads into its own page cache of 2 MB. A query whose pages do not fit
then reads each page from the operating system again on each run: on a copy
of a production database, `GET /accounts?asOfDate=...` took 58 ms without the
map and 17 ms with it. The connections share the mapped pages. `VmRSS` counts
a mapped page one time for each connection that maps it, so it shows more
than the real cost. Use the `Pss` of `/proc/<pid>/smaps_rollup` to measure the
memory of the server.

## Schema location

The schema is the SQL in `rust-api/db/migrations/`. `0001_baseline.sql` holds
the schema of the last PostgreSQL release, written for SQLite. Each later
change is a new numbered file after it. Each binary embeds the files:
`rust-api/db/build.rs` lists them, and `ledger_db::migrations` applies them.

## Making schema changes

1. Add a new file to `rust-api/db/migrations/`, with the next number, for
   example `0002_account_notes.sql`.
2. Update the Rust SQL that reads or writes the changed columns.
3. Update the entry in [schema.md](schema.md) when the change adds a rule
   that is easy to get wrong.
4. Start the server, or run `npm run db:migrate`, to apply it to the dev
   database. The tests apply it to their own files.

Each binary embeds the migration files when the `ledger-db` crate compiles.
A rustc wrapper that caches compiles (for example sccache, or a
`rustc-wrapper` in `~/.cargo/config.toml`) can return a cached `ledger-db`
that does not have a new file, because it keys on the Rust sources only. The
server, `ledger-cli` and the test databases then stop at the old version, and
no error tells you. After you add or change a migration, run
`cargo clean -p ledger-db` and build with `CARGO_BUILD_RUSTC_WRAPPER=""`.
`SELECT max(version) FROM schema_migrations` on a new database shows the
version that the binary has.

The server applies the pending migrations when it starts, before it serves a
request. A failed migration stops the start, so a new server never runs on
the old schema. On the Docker target, `docker compose up --wait` then exits 1.
On the Worker, the object answers each request with a 503 that gives the
cause, and the deploy probe fails. Each migration is one write transaction
with its `schema_migrations` row, so a failed migration leaves the schema at
the version before it, and a rollback of the Worker to the previous build
serves again. A rollback past a migration that succeeded does not: that
build has no file for the applied version and refuses to start. Fix forward
instead (see [release-and-deploy.md](release-and-deploy.md)).

Follow the type rules of the baseline:

| Kind | SQLite type |
| --- | --- |
| id | `INTEGER PRIMARY KEY AUTOINCREMENT`. An id appears in URLs, sync cursors and native-client caches, so a deleted id must never come back |
| boolean | `INTEGER` with `CHECK (x IN (0, 1))` |
| timestamp | `TEXT`, UTC, `YYYY-MM-DD HH:MM:SS[.fff]`. The Rust code binds it. No SQL default |
| date | `TEXT`, `YYYY-MM-DD` |
| JSON | `TEXT` with `CHECK (json_valid(x))`. Bind it with `sql::json()` |
| money, shares, prices | `INTEGER` (cents or micros) |

A new table that a page shows must also get the `*_mark` triggers and an
entry in `CHANGE_TABLES` (see "Live updates" below).

## ⚠️ Never edit an applied migration

Do not change a migration file after it ran on any database. Do not use
`ALTER TABLE`, `CREATE INDEX` or other DDL directly on the production
database. The runner records the SHA-384 of each applied migration in the
table `schema_migrations`. When a file no longer matches its checksum, or an
applied version has no file, the server refuses to start. A database that
an older release migrated has its history in sqlx's `_sqlx_migrations`, with
the same checksums: the first start copies those rows into
`schema_migrations`, and the old table stays, unread. A manual DDL change makes the schema different from the
migration history, and the next migration can then fail (for example,
`duplicate column name`). Make each change as a new migration file, and
deploy it. The Worker gives no shell on its database at all, so there a
migration is the only way to change the schema.

## SQL rules

Rust SQL uses the helpers in `ledger_db::sql` (`rust-api/db/src/sql.rs`):

- `today_literal()` gives today's date in the app's zone (`ledger_db::clock`,
  from `APP_TZ`, else `TZ`) as a SQL literal. Do not use `CURRENT_DATE` or
  `date('now')`: SQLite gives the UTC date. SQLite's `date(x, modifier)` on a
  literal or a bound value is fine; it reads no clock.
- `EFFECTIVE_DATE` is the effective date of a transaction row aliased `t`. It
  prints today's date each time a statement is built (`.on(today)` for a
  fixed day), so build a statement when it runs.
- `in_integers(param)` and `in_texts(param)` give
  `IN (SELECT value FROM json_each(param))`. Bind the list with
  `json_array()`. `push_in_integers()` does the same on a `store::Builder`.
- `json_rows(columns, param)` gives `SELECT ... FROM json_each(param)` over a
  JSON array of rows, in order: `#0` is the first value of a row, and any
  other entry is SQL, such as `?1`. A bulk insert is
  `INSERT INTO t (a, b, c) {json_rows(&["?1", "#0", "#1"], "?2")}` with the
  rows bound once with `json_array()`. It may take an `ON CONFLICT` clause.
- **Bind one parameter for a list, never one for each value.** A Durable
  Object refuses a statement with more than 100 bound parameters, an
  expression deeper than 100, more than 100 KB of SQL, or a compound `SELECT`
  of more than 500 terms. Every native connection has the same limits
  (`LIMITS` in `rust-api/db/src/limits.rs`), so such a statement fails in
  the tests too, and not only past some row count in production. Do not build
  `IN (...)`, `VALUES (...), (...)` or `push_values()` from a list.
- `json(param)` stores a JSON value. It checks the text.

Do not do date arithmetic in SQL. Compute the value in Rust and bind it.

### No SQL functions

No connection registers an SQL function. A Cloudflare Durable Object has
none, so the SQL uses only SQLite's own, and the server, `ledger-cli` and the
`sqlite3` shell all run the same functions on the file. Until 2026-10 the app
registered three, to keep the PostgreSQL rules: a Unicode `lower()`, a
case-sensitive `LIKE` with `\` as its default escape, and
`cp_merchant_key()`. SQLite's own `lower()` folds ASCII only and its `LIKE`
ignores ASCII case, so their work moved into stored columns:

- a comparison without letter case reads a `*_fold` column (below);
- the TypeSafe merchant key of a staged Plaid row is the stored
  `merchant_key`;
- every `LIKE` names its escape character (`ESCAPE '\'`).

A repository test fails when Rust or migration SQL names
`cp_today()`, `cp_merchant_key()` or another `cp_` function, calls a bare
`lower()`, or has a `LIKE` without an `ESCAPE`.

### Folded columns

SQLite's own `lower()` folds ASCII only (`lower('ÉCOLE')` is `École`). So
each column that a lookup or search compares without letter case has a
`*_fold` copy (migration 0012, listed in [schema.md](schema.md)), and the app
writes it with `ledger_core::names::fold()` beside its column in every insert
and update: the routes, the importer and the seed.

- An equality lookup (payee name, security symbol) compares the fold with
  `fold()` of the value. Those two have an index on `(book_id, *_fold)`.
- The global search matches `fold_column LIKE pattern ESCAPE ''`, with the
  pattern folded too. Both sides are folded, so the built-in `LIKE`, which
  folds ASCII case only, gives the case-sensitive answer. `%` and `_` in the
  query stay wildcards, as they were on PostgreSQL. The payee list matches a
  literal substring with `instr()`.

`plaid_transaction_reconciliation.merchant_key` (migration 0013) follows the
same rules: `ledger_core::names::merchant_key(merchant_name, name)`, the
TypeSafe merchant key, stored by every write of either column (the Plaid
staging writes in `routes/plaid_sync.rs` and the seed) and compared by the
TypeSafe queries. A staging update can keep the stored `merchant_name`, so
those writes return the row and store the key computed from the stored
values.

The folds are derived state. An edit in the `sqlite3` shell, or a write path
that forgets one, leaves a fold stale, and a stale fold hides the row from a
search or a lookup. `ledger_db::folds::repair()` recomputes every fold and
rewrites the ones that differ. The native server runs it at start, after the
migrations (the first start after 0012 fills them all). The Worker's object
starts again after each hibernation, so it runs the repair once for each
build (`BUILD_COMMIT`) and not at each start; an import and a restore repair
their own rows. `ledger-cli migrate`
runs it after the migrations, and `ledger-cli repair-folds` runs it by hand.
A fold is not data a client reads, so the repair removes the
`transaction_changes` rows and restores the `change_marks` versions that its
own updates' triggers wrote. Without that, the first start after 0012 would
log every transaction, and each native client would download its whole book
on its next delta sync.
After each Vitest test, `tests/setup.ts` fails the test when a fold differs
from its column, so a write path that misses one fails the suite. The
fixtures of `tests/helpers/sql.ts` (`insert`, `insertRows`) fill the folds; a
fixture that writes raw SQL must write them itself.

Text compares as bytes (`BINARY`). Thus `ORDER BY name` puts "Zebra" before
"apple". The PostgreSQL images sorted the same way (Alpine, where musl
collates `en_US.utf8` as bytes).

## The synchronous API

All database code uses one synchronous API, `ledger_db::store`
(`rust-api/db/src/store.rs`), so that the same code can later run on a
Cloudflare Durable Object, where an async database driver and tokio do not
build. The server (every route, MCP tool and scheduled job, through
`state.database`), the change hints and `ledger-cli` are on it.

- `Database::open(path, create)` opens one rusqlite connection behind a
  mutex, with the pragmas and the limits above and no SQL function.
  The `engine` module is the one place that names the backend: rusqlite
  (`engine/native.rs`) with the `native` feature, or a host connection
  (`engine/hosted.rs`, a Durable Object's `SqlStorage`) without it.
- The `Sql` trait has `query`, `query_row`, `query_optional`, `execute` and
  `exec_batch`. A `Database` and a `Transaction` both implement it, so a
  helper takes `&impl Sql`. Rows decode to a single column's type, a tuple,
  a `Row`, or a struct that derives `ledger_db::store::FromRow`. The derive
  reads each field from the column of its name, so the order of the `SELECT`
  list does not matter; `#[row(rename = "...")]` reads another column. A
  query whose result lacks a field's column fails with
  `Error::NoColumnNamed`.
- `store::Error::is_unique_violation()` and `is_foreign_key_violation()`
  name the SQLite constraint that failed, so a route can answer 409 without
  reading the message, and the SQL text never reaches a client.
- Bind values by position with `params![a, b]` and write the placeholders as
  `?1`, `?2`. `$1` also parses, but SQLite numbers `$N` names in order of
  first use, so `$2` before `$1` would bind the wrong values.
- `database.transaction(|tx| { ... })` commits when the closure returns `Ok`
  and rolls back on `Err` or a panic. The closure is synchronous: finish the
  slow work (a hash, a network call) before it. Inside, use `tx`; a call on
  the `Database` waits for the mutex the closure holds and never returns.
  Never write `BEGIN` or `COMMIT` in SQL. `database.read_transaction(...)`
  is the same with `BEGIN DEFERRED`, for reads that must agree on one
  snapshot. A route calls them through `write_transaction` and
  `read_transaction` in `rust-api/server/src/db_scope.rs`.
- `tx.savepoint(|sp| { ... })` runs a unit inside the transaction: its
  writes stay on `Ok`, and only they roll back on `Err`. The inner result is
  the closure's; the outer error is a failure of the savepoint itself. The
  Moneydance import uses it to skip a bad row and keep the rest. A Durable
  Object has no savepoint, so the server does not use it.
- `store::Builder` builds a statement with optional clauses: `push()` adds
  SQL, `push_bind()` adds a value and writes its `?N`, and
  `push_in_integers()` adds an `IN` list bound once. Run it with
  `query`, `query_row`, `query_optional` or `execute` on any `Sql`.
- An integer past 2^53 - 1 fails to bind and fails to read
  (`Error::UnsafeInteger`). A Durable Object passes values through
  JavaScript numbers, which round such an integer without an error. The
  largest integer the app stores is `transaction_changes.seq`, a time in
  microseconds (between 2^50 and 2^51 today); a test reads every integer of the
  sample data back through the API.
- Calls run on the async runtime's thread, with no `platform::blocking`. The
  fold repair of 2,285 rows takes about 40 ms in a debug build. Measure
  before adding `platform::blocking`. Three paths use it: the demo book's seed,
  which writes thousands of rows and takes seconds, so it runs on a blocking
  thread and commits even when the client leaves; and the scheduled backup
  and `VACUUM`, which each open their own connection to the file
  (`ledger_db::backup`), so the shared connection stays free for the routes
  while they run.

## Locks

`ledger_db::locks` (`rust-api/db/src/locks.rs`) holds every lock:

- **Write transactions** open with `Database::transaction`, which sends
  `BEGIN IMMEDIATE` (rusqlite's `TransactionBehavior::Immediate`; its
  default is deferred) and takes the write lock of the file at once. A
  second writer, from this process or another, waits up to the busy timeout.
  A deferred `BEGIN` can fail with `SQLITE_BUSY` when a read changes to a
  write, so `clippy.toml` forbids rusqlite's own `Connection::transaction`.
- **Leases** (`job_leases`, `rust-api/server/src/leases.rs`) span several
  transactions, for example a Plaid sync that calls the network between
  them, or a run of a scheduled job. A lease is a row, so it also holds
  against the MCP stdio process and needs no file beside the database. The
  holder renews it while it runs; a crashed holder's lease lapses after 60
  seconds. `try_take` does not wait: a second caller gets `None`.
- The `FOR_UPDATE` constant is empty. `BEGIN IMMEDIATE` already holds the
  write lock.

## Live updates

A page listens on `GET /api/b/{bookId}/socket` for change hints. Insert,
update and delete triggers on 14 tables count the changes of each (book,
table) in the table `change_marks`. `BookChangeHub`
(`rust-api/server/src/book_changes.rs`) reads the counts of each subscribed
book every 100 ms, and a count that moved is a hint. The triggers run for
every writer: the server, `ledger-cli`, MCP over stdio and the `sqlite3`
shell. A write that rolls back also rolls back its count.

The table `transaction_changes` logs the ID of each changed transaction for
the delta sync of a native client. Its triggers run for every writer too. See
[api-contract.md](api-contract.md#delta-sync).

## Backups and restore

The server makes the backups itself (`rust-api/server/src/scheduler/mod.rs`):

- Hourly from 06:00 to 21:00 in `TZ`, it writes a snapshot into
  `BACKUP_DIR` (default `/backups`) with `VACUUM INTO`, first as
  `counterpoise-YYYYMMDD-HHMMSS.db.partial`. Then it runs
  `PRAGMA integrity_check` on the copy, read-only, and syncs it. Only a copy
  that passes gets the name `counterpoise-YYYYMMDD-HHMMSS.db`; a copy that
  fails gets `.db.bad` and the job status says `verified: false`. The rename
  never replaces a file. Thus a file with the normal name is always complete
  and checked.
- The first backup of each UTC day also writes a portable dump,
  `counterpoise-YYYYMMDD-HHMMSS.json` (see [Dump and load](#dump-and-load)).
  A failed dump does not fail the backup; the job status names it in
  `detail`.
- Daily at 04:00, it deletes the files named exactly
  `counterpoise-YYYYMMDD-HHMMSS.db`, `counterpoise-YYYYMMDD-HHMMSS.json` or
  `counterpoise-YYYYMMDD-HHMMSS.dump` (the hourly dumps of the PostgreSQL
  releases) that are older than 30 days,
  then runs `PRAGMA optimize`. It does not delete a `.partial` or `.bad`
  file, or the safety dump of the upgrade
  (`counterpoise-pre-sqlite-<time>.dump`). Delete those by hand.
- On the 1st of each month at 03:00, it runs `VACUUM`.

To make a snapshot now, run `ledger-cli backup [--dir D]`. On the Docker
target: `docker exec counterpoise-rust-api-1 ledger-cli backup`. The Worker
has no `ledger-cli` and no snapshots: see
[Backups on the Worker](#backups-on-the-worker).

### Dump and load

A Durable Object has no file and no `VACUUM INTO`, so the data moves between
a native file and an object as a dump (`rust-api/db/src/dump.rs`): one JSON
document with the applied migrations (version and checksum) and the rows of
every table, `sqlite_sequence` included. It holds no DDL.

- `ledger-cli dump <file>` writes one from one read snapshot, while the
  server runs. The file must not exist.
- `ledger-cli load <file>` creates the file that `DATABASE_PATH` names,
  which must not exist. It applies the dump's migrations, loads the rows in
  one write transaction, then applies the migrations that the dump lacks,
  so a dump from an older release loads into a newer one. It refuses a dump
  with a migration this build does not have or with another checksum. A
  failed load removes the file it made.
- The load drops the triggers while the rows go in and makes them again
  after, so that the change logs are not written twice and a book's owner is
  not added twice. It inserts the tables in foreign-key order, each in
  chunks of one JSON parameter (`json_rows`), checks
  `PRAGMA foreign_key_check`, and adds a floor marker to the change log, as a
  snapshot does, so a native client downloads its book again.
- A value is a JSON integer, number, string or null. The dump refuses a
  blob or a non-finite number: no table outside `schema_migrations` holds
  one.

To restore from a dump instead of a snapshot: stop the server, move the
database file and its `-wal` and `-shm` files away, run `ledger-cli load`,
and start the server.

Each snapshot is a complete database. To restore one, stop the server, copy
the snapshot over the database file, delete the `-wal` and `-shm` files, and
start the server. [upgrade-to-sqlite.md](upgrade-to-sqlite.md) has the
production command. A restored file with splits and no lots gets its lots
back at startup, from the lot backfill guard.

A restore also brings back an older `transaction_changes` log, which gives
again `seq` values that a native client already has. To stop a client from
missing the changes that the restore removed, `backup::snapshot` writes a
floor marker (a log row of book 0) into each copy, 2^32 above the newest
`seq` of the copy. A delta cursor below the newest marker gets 410, and the
client downloads the book again. Migration 0003 starts the log with a marker
at the current time in microseconds, so a restored snapshot from before that
migration also gets a marker above the old cursors. Restore only from a
snapshot. A copy of the database file made in another way has no marker.

### Backups on the Worker

A Durable Object has no file to copy, so its `backup` job exports the day's
dump instead (`backup` and `export` in `rust-api/server/src/scheduler/mod.rs`):

- Daily at 03:45 in the app's zone, the alarm writes the dump into the
  `EXPORTS` bucket as `counterpoise-YYYY-MM-DD.json` (the `ledger-cli dump`
  format). A second run on one day replaces that day's object. The job
  status `backup` gives its size in `bytes`, or the error in `detail`. The
  object binds the bucket at construction (`export_to` in
  `rust-api/worker/src/object.rs`); without the binding the job fails and
  says so.
- The dump leaves out the runtime's own tables of the object's file:
  Cloudflare's `_cf_*`, which it refuses to let anyone read, and
  `wrangler dev`'s `__miniflare_do_name`.
- The bucket keeps 30 days through a lifecycle rule, set once per bucket:
  `scripts/wrangler.sh r2 bucket lifecycle add <bucket> expire-dumps --expire-days 30`.
- The object has no prune of backup files and no reindex. Its `prune` job
  still prunes the rate limits.

To restore from a dump, fetch it with
`scripts/wrangler.sh r2 object get <bucket>/counterpoise-YYYY-MM-DD.json --remote --file dump.json`.
Then either `ledger-cli load dump.json` into a native file, as above, or
load it into an empty object through the admin import route, below. Both
paths add the floor marker.

### The admin import route

`POST /api/admin/import` loads a dump into a Durable Object that holds no
user and no book. The cutover uses it to move the native server's data into
the object. The handler is in `rust-api/server/src/hosted/import.rs`, and
`ledger_db::dump::import()` does the loading.

- The route exists only on the Worker, and only while the object has the
  secret `IMPORT_SECRET`. Without the secret the path is a plain 404. The
  caller sends `Authorization: Bearer $IMPORT_SECRET`, as for `CRON_SECRET`.
  An empty object has no user to sign in, so the secret is the only check.
  Delete the secret once the import is done:
  `../../scripts/wrangler.sh secret delete IMPORT_SECRET` in `rust-api/worker/`.
- The body is the whole dump, up to 64 MiB:
  `curl -X POST -H "Authorization: Bearer $IMPORT_SECRET" --data-binary @dump.json https://<host>/api/admin/import`.
  The answer gives the tables and rows loaded.
- The Worker reads each request body before the object sees it, and bounds
  that read by the route's own limit (`hosted::body_limit`): 4 MiB for
  `/api/mcp`, 2 MiB (axum's default) for every other route. The import gets
  its 64 MiB only when the request carries the secret, and only with a
  `Content-Length` (411 without one), so that the Worker holds the dump
  once. Anything larger is a 413 from the Worker.
- The dump must be at the object's migration. The object migrates when it
  starts, so a dump from an older release is refused. To use one, load it
  into a file with `ledger-cli load`, start a server of this release on that
  file once so it migrates, and dump it again.
- An object with a user or a book gets 409. The import first clears what a
  started object writes with neither: the job records and the rate limits.
- The load is one write transaction. A dump that fails, such as a row that
  names a missing row, leaves the object as it was. After the load, the
  route runs the steps of the object's start that read the rows: marking
  the weekly reviews that show as running failed (no task of the object
  runs them), the lot check, the folded columns, and sealing the Plaid
  tokens. When one of them
  fails, such as a Plaid token sealed with a key that the Worker lacks, the
  route removes every imported row again (`dump::clear()`) and answers 500
  with the cause, so the object is empty and takes the corrected dump.
- After a successful import the Worker sets the alarm again from the
  imported job tables, which can hold work that is due now.
- The loader reads each row as the text of the dump and parses only one row
  at a time, so a load needs little more memory than the dump's size.

### Point-in-time restore

Cloudflare also keeps 30 days of point-in-time recovery for the object.
`POST /api/admin/restore` takes the object back to a time of those 30 days.
The checks are in `rust-api/server/src/hosted/restore.rs`, and the object
does the restore in `rust-api/worker/src/object.rs`, with the bookmark calls
that `rust-api/worker/src/storage.rs` binds.

- The route is behind `IMPORT_SECRET`, as the import is: without the secret
  it is a plain 404, and the caller sends
  `Authorization: Bearer $IMPORT_SECRET`. Set the secret for the restore and
  delete it afterwards.
- The body is `{"at": "<RFC 3339 time>"}`, or `{"bookmark": "<bookmark>"}` to
  restore a bookmark that an earlier restore returned:
  `curl -X POST -H "Authorization: Bearer $IMPORT_SECRET" -d '{"at": "2026-10-23T09:00:00Z"}' https://<host>/api/admin/restore`.
  A time in the future or more than 30 days back is a 400.
- The object records the bookmarks in the export bucket (`restore-last`)
  and then resets at once, as Cloudflare's recovery does: the storage
  restores at the next start, and a storage that waits for its restore
  serves nothing. The reset fails the request. The Worker names each
  restore request (the `x-counterpoise-restore` header, which it sets
  itself), and the marker and the record carry the name, so on the failure
  it answers 202 with this request's record:
  `{"request": ..., "bookmark": ..., "undo": ..., "requestedAt": ...}`.
  When the restore was scheduled and its record was not stored, it answers
  500, and the object's log has the bookmarks. With neither, the restore
  did not start, and the failure is passed on.
  `GET /api/admin/restore`, with the same header, gives the last record.
  Keep `undo`: posting it as the bookmark takes the object back to where it
  was before the restore. A write after the restored time is lost.
- The route needs no started server, so it can take back a database that a
  release fails to start on.
- A restore takes the change log back with the data, so a native client's
  cursor can be past the restored log. Before the object tells the storage
  to restore, it writes the key `restore-pending` to the export bucket,
  which a restore does not touch. The first start that finds the key, before
  it serves anything, adds a floor marker (`sync_floor::insert`), as a
  snapshot has, runs the steps of the start that read the rows, and then
  deletes the key. Every native client then downloads its book again. When
  the bucket cannot be read, the object resets and the next event tries
  again, so nothing is served before the marker is in. A refused restore
  deletes the key again, unless an earlier restore left it.

### Production data on the Worker

The object's storage is not a file, so nothing opens it with `sqlite3` or
`ledger-cli`. Use one of these paths:

- **To read it**, fetch the newest daily export from the bucket (above),
  run `ledger-cli load` into a temporary file, and open that file with
  `sqlite3`. The copy is as old as the export. Delete the copy when you are
  done: it holds production data.
- **To change it**, use the app, the API or MCP. A change to a local copy
  does not reach the object. A change to the schema is a migration.
- **To take it back to an earlier time**, use
  [point-in-time restore](#point-in-time-restore). The import route loads
  only an object with no user and no book, so it cannot replace the data
  of a live object.

## Separate development and production

- Development runs `cargo run` and keeps `data/counterpoise.db` in the
  checkout. It needs no Docker and no Cloudflare account.
- The Docker target uses `docker-compose.yml` in its own checkout on `main`
  (`~/counterpoise-production` by default), with the volume `counterpoise_data`.
  Never point a development process at the production file. The server lock
  stops a second server on one file, but not a second process that opens a
  copy.
- The Worker target keeps its data in the Durable Object. A development
  process cannot open it. `npm run worker:dev` runs a local object with its
  own file under `rust-api/worker/.wrangler/`.
- A production install that still has data in PostgreSQL must convert it
  once. See [upgrade-to-sqlite.md](upgrade-to-sqlite.md).
