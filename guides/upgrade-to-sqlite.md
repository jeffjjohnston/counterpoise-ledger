# Upgrade from PostgreSQL to SQLite

## If you run v1.48.0

v1.48.0 is the last Counterpoise release that uses PostgreSQL. The first
SQLite release is the next minor release after v1.48.0. That release needs a
one-time conversion of your data.

- Do not upgrade to the SQLite release without the procedure on this page.
- Until the SQLite release is published, you have nothing to do. Keep this
  page for the upgrade.
- The script and the Compose file that this procedure uses,
  scripts/upgrade-to-sqlite.sh and docker-compose.upgrade.yml, come with the
  SQLite release. v1.48.0 does not contain them.

The rest of this page describes the SQLite release.

## About the SQLite release

Counterpoise stores its data in one SQLite file from the SQLite release.
Earlier releases used a PostgreSQL container. An install that has data in
PostgreSQL must convert it **once**, with the procedure on this page, before
the new release can start.

A new install of the SQLite release does not need this page. It creates the
data volume and starts:

```bash
docker volume create counterpoise_data
docker compose --env-file .env.production.local up -d --wait
```

## What changes

| Before | After |
| --- | --- |
| Three services: `rust-api`, `postgres`, `scheduler` | One service: `rust-api` |
| Data in the volume `counterpoise_pgdata` | Data in the volume `counterpoise_data`, file `/data/counterpoise.db` |
| Hourly `pg_dump` files (`counterpoise-*.dump`) | Hourly SQLite snapshots (`counterpoise-*.db`), checked with `PRAGMA integrity_check` |
| `DATABASE_URL`, `POSTGRES_PASSWORD`, `APP_DB_PASSWORD` | Not used. `DATABASE_PATH` is optional (default `/data/counterpoise.db`) |
| `CRON_SECRET` required | Optional. The server runs the jobs itself; the secret only gates the manual `/api/cron/*` triggers |

IDs do not change. Links, API keys (`cpk_...`), sessions, Plaid cursors and the
caches of native clients stay valid.

## Before you start

1. **Upgrade to v1.48.0, the last PostgreSQL release, first.** The converter
   reads only the schema of that release, and it refuses an older database.
   v1.48.0 shows a notice that names this page, on the book pages and in the
   server log.
2. **Make sure that you have space** for a second copy of the data and a
   `pg_dump` safety copy in the backups directory.
3. **Plan a short stop.** The app is down from step 2 of the script until you
   start the new release. For a typical personal install, this is less than a
   minute plus the image build.

## Steps

Do these steps in the install's checkout (the directory that holds
`docker-compose.yml` and `.env.production.local`).

1. Check out the first SQLite release:

   ```bash
   git fetch && git checkout vX.Y.Z   # the first SQLite release
   ```

2. Run the upgrade script. The SQLite release contains it:

   ```bash
   scripts/upgrade-to-sqlite.sh
   ```

   The script:
   - checks that `counterpoise_pgdata` exists and that no SQLite database
     exists yet;
   - stops the containers of the `counterpoise` project (it does not remove
     them);
   - starts the old PostgreSQL on `counterpoise_pgdata`, in a separate Compose
     project (`docker-compose.upgrade.yml`);
   - writes a `pg_dump` safety copy into `backups/`
     (`counterpoise-pre-sqlite-<time>.dump`), and checks it with
     `pg_restore --list`;
   - creates the volume `counterpoise_data` and runs
     `ledger-cli import-postgres` into it;
   - stops the old PostgreSQL, and makes `backups/` writable for the server
     (uid 1000).

   The converter writes the summary of its checks into
   `backups/sqlite-conversion-<time>.txt`. Keep it.

3. Start the new release:

   ```bash
   docker compose --env-file .env.production.local up -d --wait
   ```

   Always give `--env-file .env.production.local`. Compose reads values such
   as `APP_BIND`, `TZ` and `COUNTERPOISE_BACKUPS_DIR` in the Compose file from
   this file. Without it, Compose uses the defaults.

4. Sign in. Compare the balances of some accounts with what you know.

5. **After a week of use**, clean up:
   - Remove `DATABASE_URL`, `POSTGRES_PASSWORD` and `APP_DB_PASSWORD` from
     `.env.production.local`.
   - Remove the old `postgres` and `scheduler` containers. The script stopped
     them but did not remove them. Docker does not delete a volume that a
     container uses, even when the container is stopped:

     ```bash
     docker compose --env-file .env.production.local up -d --wait --remove-orphans
     ```

   - Delete the old data: `docker volume rm counterpoise_pgdata`.
   - Delete the old `counterpoise-*.dump` files from `backups/` when you no
     longer need them. The daily prune deletes them after 30 days.

## What the converter checks

`ledger-cli import-postgres` copies each table in foreign-key order and keeps
every ID and every sequence position. Then it checks the copy:

- every row and every value of every table, against the source;
- the sum of the splits of each book, against the source, and that it is zero;
- the balance of each account;
- the investment lots, against a fresh rebuild of the lots from the splits;
- `PRAGMA foreign_key_check` and `PRAGMA integrity_check`.

It writes `counterpoise.db.partial` first, and renames it to `counterpoise.db`
only when every check passes. When a check fails, the script stops and tells
you. `counterpoise_pgdata` does not change.

### A book that does not balance

If the splits of a book do not sum to zero in PostgreSQL, the converter
refuses it and names the book and the amount. This is a problem in the source
data, not in the conversion. Examine the book in v1.48.0 first.
When you accept the book as it is, run the script again with the flag:

```bash
scripts/upgrade-to-sqlite.sh --allow-unbalanced
```

The copy then keeps the same sums as the source.

## If something goes wrong

- **The script stops before the conversion passes.** Nothing is lost:
  `counterpoise_pgdata` is unchanged. Remove the volume `counterpoise_data` if
  the script made it, check out v1.48.0, and start it with
  `docker compose --env-file .env.production.local up -d`.
- **The new release does not start.** Read `docker compose logs rust-api`.
  If it says that `DATABASE_URL` is set and there is no database, the
  conversion did not run: do step 2.
- **You want to go back after you used the new release.** Check out v1.48.0
  and start it with `docker compose --env-file .env.production.local up -d`.
  It uses `counterpoise_pgdata`, which does not have the changes that you made
  in the new release.

## Restore from a SQLite snapshot

Each hourly snapshot is a complete database. To restore one:

```bash
docker compose --env-file .env.production.local stop rust-api
docker run --rm -v counterpoise_data:/data -v "$PWD/backups:/backups:ro" alpine \
  sh -c 'rm -f /data/counterpoise.db-wal /data/counterpoise.db-shm &&
         cp /backups/counterpoise-YYYYMMDD-HHMMSS.db /data/counterpoise.db &&
         chown 1000:1000 /data/counterpoise.db'
docker compose --env-file .env.production.local up -d --wait
```

To make a snapshot now: `docker exec counterpoise-rust-api-1 ledger-cli backup`.
