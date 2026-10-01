# Upgrade from PostgreSQL to SQLite

Counterpoise stores its data in one SQLite file from this release. Earlier
releases used a PostgreSQL container. An install that has data in PostgreSQL
must convert it **once**, with the procedure on this page, before the new
release can start.

A new install does not need this page. It creates the data volume and starts:

```bash
docker volume create counterpoise_data
docker compose --env-file .env.production.local up -d --wait
```

## What changes

| Before | After |
| --- | --- |
| Three services: `rust-api`, `postgres`, `scheduler` | One service: `rust-api` |
| Data in the volume `counterpoise_pgdata` | Data in the volume `counterpoise_data`, file `/data/counterpoise.db` |
| Hourly `pg_dump` files (`counterpoise-*.dump`), named in local time | Hourly SQLite snapshots (`counterpoise-*.db`), checked with `PRAGMA integrity_check` and named in UTC |
| `DATABASE_URL`, `POSTGRES_PASSWORD`, `APP_DB_PASSWORD` | Not used. `DATABASE_PATH` is optional (default `/data/counterpoise.db`) |
| `CRON_SECRET` required | Optional. The server runs the jobs itself; the secret only gates the manual `/api/cron/*` triggers |

IDs do not change. Links, API keys (`cpk_...`), sessions, Plaid cursors and the
caches of native clients stay valid.

### One writer at a time

SQLite lets one writer change the file at a time. A second writer waits up to
5 seconds (`BUSY_TIMEOUT`). Two long writes can hold the file for more than
that:

- `ledger-cli import-moneydance`, which writes the whole import in one
  transaction;
- the monthly `VACUUM` (03:00 on the 1st of the month), which rebuilds the
  file.

While one of them runs, a save in the app, a Plaid sync or a scheduled job can
fail after 5 seconds with `database is locked` in the server log. The failed
write changes nothing: its transaction rolls back, and no data is lost. Do the
action again when the long write is done. Reads continue during both.

## Before you start

1. **Upgrade to v1.48.0, the last PostgreSQL release, first.** The converter
   reads only the schema of that release, and it refuses an older database.
   v1.48.0 shows a notice that names this page, on the book pages and in the
   server log.
2. **Make sure that you have space** for a second copy of the data and a
   `pg_dump` safety copy in the backups directory.
3. **Plan a short stop.** The script builds the new image first, while the
   app runs. The app is down from the stop until you start the new release.
   For a typical personal install, this is less than a minute.

## Steps

Do these steps in the install's checkout (the directory that holds
`docker-compose.yml` and `.env.production.local`).

1. Check out the first public SQLite release:

   ```bash
   git fetch && git checkout v1.50.0   # the first public SQLite release
   ```

2. Run the upgrade script:

   ```bash
   scripts/upgrade-to-sqlite.sh
   ```

   The script:
   - checks that `counterpoise_pgdata` exists and that no SQLite database
     exists yet;
   - refuses when a container that is not of the `counterpoise` project runs
     on `counterpoise_pgdata`. Two PostgreSQL servers on one data directory
     can damage it, and the script does not stop a container that it does
     not own. Stop that container, then run the script again;
   - builds the new image while the app still runs;
   - stops the containers of the `counterpoise` project (it does not remove
     them), and makes sure that no container runs on `counterpoise_pgdata`;
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
     longer need them. The daily prune deletes the hourly dumps after 30
     days. It never deletes the safety copy
     `counterpoise-pre-sqlite-<time>.dump`: delete it by hand when you are
     sure that you do not need it.

## What the converter checks

`ledger-cli import-postgres` copies each table in foreign-key order and keeps
every ID and every sequence position. Then it checks the copy:

- every row and every value of every table, against the source;
- the sum of the splits of each book, against the source, and that it is zero;
- the balance of each account;
- the investment lots, against a fresh rebuild of the lots from the splits;
- `PRAGMA foreign_key_check` and `PRAGMA integrity_check`.

A pair (account, security) with a floating investment transaction is the one
exception to the lot check. Its lots keep the date of the day of their last
rebuild, so they can differ from a rebuild today. The converter rebuilds the
lots of those pairs in the copy, and the summary says "rebuilt N pairs that
have floating transactions". The lots are derived from the splits, so no data
is lost. Every other difference in the lots stops the conversion.

It holds the server lock (`counterpoise.db.lock`) while it runs, so a server
or a second conversion cannot use the file. It writes
`counterpoise.db.partial` first. Only when every check passes does it give the
file the name `counterpoise.db`, and it never replaces a file with that name.
When a check fails, the script stops and tells you. `counterpoise_pgdata`
does not change.

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
  `counterpoise_pgdata` is unchanged. When the app was already stopped, the
  script says so and gives these commands. Check out v1.48.0, and start it
  with `docker compose --env-file .env.production.local up -d --build`. Do
  not leave out `--build`: the script replaced the image of the same name
  with the new release, and without `--build` Compose starts that image. The
  build takes a few minutes. The volume `counterpoise_data` can stay: a new
  run of the script uses it again.
- **The new release does not start.** Read `docker compose logs rust-api`.
  If it says that `DATABASE_URL` is set and there is no database, the
  conversion did not run: do step 2.
- **You want to go back after you used the new release.** Check out v1.48.0
  and start it with
  `docker compose --env-file .env.production.local up -d --build`.
  It uses `counterpoise_pgdata`, which does not have the changes that you made
  in the new release.

## Restore from a SQLite snapshot

Each hourly snapshot is a complete database. Its name gives the time in UTC,
not in local time: `counterpoise-20261001-130000.db` is 09:00 in New York.
The old `pg_dump` files used local time. To restore a snapshot:

```bash
docker compose --env-file .env.production.local stop rust-api
docker run --rm -v counterpoise_data:/data -v "$PWD/backups:/backups:ro" alpine \
  sh -c 'rm -f /data/counterpoise.db-wal /data/counterpoise.db-shm &&
         cp /backups/counterpoise-YYYYMMDD-HHMMSS.db /data/counterpoise.db &&
         chown 1000:1000 /data /data/counterpoise.db'
docker compose --env-file .env.production.local up -d --wait
```

To make a snapshot now: `docker exec counterpoise-rust-api-1 ledger-cli backup`.
