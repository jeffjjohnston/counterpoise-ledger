# Database Management

One of the guides [CLAUDE.md](../CLAUDE.md) points to. Read that file first;
it carries the rules that apply everywhere and says when to come here.

## The database

Counterpoise keeps all data in one SQLite file. `DATABASE_PATH` names it:

| Where | Default |
| --- | --- |
| Production image | `/data/counterpoise.db`, on the volume `counterpoise_data` |
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
- `counterpoise.db.locks/`: the session lock files (see "Locks" below).

Usage: `ledger-cli seed [--book-id N | --reset] [--dataset household|single]
[--today YYYY-MM-DD]`. The dates end today in the app's `TZ`; `--today`
pins them. `--today 2025-12-31` gives the 2023-2025 household rows (2,235
transactions). The count depends on `today`.

Each connection sets `journal_mode=WAL`, `foreign_keys=ON`,
`busy_timeout=5000`, `synchronous=FULL` and `mmap_size` (256 MB,
`MMAP_SIZE` in `rust-api/db/src/database.rs`). A test asserts them on every
pooled connection.

`synchronous=FULL` syncs the WAL to the disk at each commit, before the
commit returns. With `NORMAL` and WAL, a commit that returned can be lost
when the power fails or the machine (or the Docker VM) stops. A lost commit
is a lost transaction in the ledger. Do not change it to `NORMAL` for speed.
The server, `ledger-cli`, the converter and the tests all open the file
with `ledger_db::open`, so they all get this setting.

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
change is a new numbered file after it. Each binary embeds the files with
`sqlx::migrate!`.

## Making schema changes

1. Add a new file to `rust-api/db/migrations/`, with the next number, for
   example `0002_account_notes.sql`.
2. Update the Rust SQL that reads or writes the changed columns.
3. Update the entry in [schema.md](schema.md) when the change adds a rule
   that is easy to get wrong.
4. Start the server, or run `npm run db:migrate`, to apply it to the dev
   database. The tests apply it to their own files.

The server applies the pending migrations when it starts, before it serves a
request. A failed migration stops the start, so a new server never runs on
the old schema. In production, `docker compose up --wait` then exits 1.

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
database. sqlx records the checksum of each applied migration in the table
`_sqlx_migrations`. When a file no longer matches its checksum, the server
refuses to start. A manual DDL change makes the schema different from the
migration history, and the next migration can then fail (for example,
`duplicate column name`). Make each change as a new migration file, and
deploy it.

## SQL rules

Rust SQL uses the helpers in `ledger_db::sql` (`rust-api/db/src/sql.rs`):

- `today!()` gives `cp_today()`: today's date in the app's `TZ`. Do not use
  `CURRENT_DATE` or `date('now')`: SQLite gives the UTC date.
- `EFFECTIVE_DATE` is the effective date of a transaction row aliased `t`.
- `in_integers(param)` and `in_texts(param)` give
  `IN (SELECT value FROM json_each(param))`. Bind the list with
  `json_array()`.
- `json(param)` stores a JSON value. It checks the text.
- `MERCHANT_KEY` is the TypeSafe merchant key of a staged Plaid row.

Do not do date arithmetic in SQL. Compute the value in Rust and bind it.

### Functions registered on each connection

SQLite and PostgreSQL treat text differently. `ledger_db::functions`
(`rust-api/db/src/functions.rs`) registers these functions on each
connection, so that the app keeps the PostgreSQL rules:

- `lower(x)` folds Unicode case. The built-in folds ASCII only.
- `LIKE` is case-sensitive, and `\` is its escape character when the SQL
  names none. The built-in folds ASCII case.
- `cp_today()` is today's date in `TZ`.
- `cp_merchant_key(merchant_name, name)` is
  `ledger_core::names::merchant_key`.

The `sqlite3` shell does not have these functions. It uses the built-in
`lower` and `LIKE`, so a query that uses them can give a different answer in
the shell. No table, trigger or index uses the functions, so the shell can
still read and write the file.

Text compares as bytes (`BINARY`). Thus `ORDER BY name` puts "Zebra" before
"apple". The PostgreSQL images sorted the same way (Alpine, where musl
collates `en_US.utf8` as bytes).

## Locks

`ledger_db::locks` (`rust-api/db/src/locks.rs`) holds every lock:

- **Write transactions** open with `locks::begin` or `locks::begin_pool`. They
  send `BEGIN IMMEDIATE`, which takes the write lock of the file at once. A
  second writer, from this process or another, waits up to the busy timeout.
  A deferred `BEGIN` can fail with `SQLITE_BUSY` when a read changes to a
  write, so `clippy.toml` forbids `Connection::begin`.
- **Session locks** (`with_session_lock`) span several transactions, for
  example a Plaid sync that calls the network between them. Each is a file
  lock under `counterpoise.db.locks/`, so it also holds against the MCP stdio
  process. A second caller does not wait: it gets `None`.
- The `FOR_UPDATE` constant is empty. `BEGIN IMMEDIATE` already holds the
  write lock.

## Live updates

A page listens on `GET /api/b/{bookId}/events` for change hints. Insert,
update and delete triggers on 14 tables count the changes of each (book,
table) in the table `change_marks`. `BookChangeHub`
(`rust-api/server/src/book_changes.rs`) reads the counts of each subscribed
book every 100 ms, and a count that moved is a hint. The triggers run for
every writer: the server, `ledger-cli`, MCP over stdio and the `sqlite3`
shell. A write that rolls back also rolls back its count.

## Backups and restore

The server makes the backups itself (`rust-api/server/src/scheduler.rs`):

- Hourly from 06:00 to 21:00 in `TZ`, it writes a snapshot into
  `BACKUP_DIR` (default `/backups`) with `VACUUM INTO`, first as
  `counterpoise-YYYYMMDD-HHMMSS.db.partial`. Then it runs
  `PRAGMA integrity_check` on the copy, read-only, and syncs it. Only a copy
  that passes gets the name `counterpoise-YYYYMMDD-HHMMSS.db`; a copy that
  fails gets `.db.bad` and the job status says `verified: false`. The rename
  never replaces a file. Thus a file with the normal name is always complete
  and checked.
- Daily at 04:00, it deletes the files named exactly
  `counterpoise-YYYYMMDD-HHMMSS.db` or `counterpoise-YYYYMMDD-HHMMSS.dump`
  (the hourly dumps of the PostgreSQL releases) that are older than 30 days,
  then runs `PRAGMA optimize`. It does not delete a `.partial` or `.bad`
  file, or the safety dump of the upgrade
  (`counterpoise-pre-sqlite-<time>.dump`). Delete those by hand.
- On the 1st of each month at 03:00, it runs `VACUUM`.

To make a snapshot now, run `ledger-cli backup [--dir D]`. In production:
`docker exec counterpoise-rust-api-1 ledger-cli backup`.

Each snapshot is a complete database. To restore one, stop the server, copy
the snapshot over the database file, delete the `-wal` and `-shm` files, and
start the server. [upgrade-to-sqlite.md](upgrade-to-sqlite.md) has the
production command. A restored file with splits and no lots gets its lots
back at startup, from the lot backfill guard.

## Separate development and production

- Development runs `cargo run` and keeps `data/counterpoise.db` in the
  checkout. It needs no Docker.
- Production uses `docker-compose.yml` in its own checkout on `main`
  (`~/counterpoise-production` by default), with the volume `counterpoise_data`.
  Never point a development process at the production file. The server lock
  stops a second server on one file, but not a second process that opens a
  copy.
- A production install that still has data in PostgreSQL must convert it
  once. See [upgrade-to-sqlite.md](upgrade-to-sqlite.md).
