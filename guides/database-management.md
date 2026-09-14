# Database Management

One of the guides [CLAUDE.md](../CLAUDE.md) points to. Read that file first;
it carries the rules that apply everywhere and says when to come here.

## Schema Location
- All tables (meta + book-scoped): `/db/schema.ts`

## Making Schema Changes
1. Edit `/db/schema.ts`
2. Run `npm run db:generate` to create a migration in `/db/migrations/`
3. Run `npm run db:migrate` to apply the migration
4. Commit **all** generated files: the SQL migration (`db/migrations/NNNN_*.sql`), the snapshot (`db/migrations/meta/NNNN_snapshot.json`), and the updated journal (`db/migrations/meta/_journal.json`). Drizzle needs the snapshot to compute future diffs correctly.
5. Update TypeScript types (Drizzle auto-generates)

Migrations are NOT auto-applied by `getDb()`. Use `npm run db:migrate` (or `runMigrations()` in scripts). Test helpers handle migrations for tests.

## ⚠️ Never Manually Alter the Production Database
Do not use `ALTER TABLE`, `CREATE INDEX`, or other DDL statements directly against the production database. Drizzle tracks applied migrations by hash in its `__drizzle_migrations` table — manual changes desync the schema from the migration history, causing future migrations to fail (e.g., `column already exists`). Always make schema changes through `db/schema.ts` → `npm run db:generate` → deploy.

## Database Location
- Local PostgreSQL default: `postgresql://counterpoise:counterpoise@localhost:5432/counterpoise_dev`
- The `counterpoise_dev` database is created by `npm run db:create-test-dbs` — Docker Compose only creates the `counterpoise` database
- Docker deployment database: `counterpoise`, reached as the **`counterpoise_app`** role, not the bootstrap one
- Override with `DATABASE_URL` environment variable
- Run `docker compose -f docker-compose.dev.yml up -d --wait` to start the dedicated dev/test instance
- Dev uses project `counterpoise-dev` and volume `counterpoise_dev_pgdata`, publishing only `127.0.0.1:5432`.
- Production uses `docker-compose.yml` in its own checkout on `main`
  (`~/prod/counterpoise` by default), with volume `counterpoise_pgdata` and no host PostgreSQL port. Never point dev/test at production.
- Inspect with `npx drizzle-kit studio` (see Essential Commands)

## Separate Development and Production Instances

Development uses the published `counterpoise:counterpoise` bootstrap credential
on its own container. Dev, E2E and per-run Vitest databases live there.
Production has its own bootstrap role and the non-superuser `counterpoise_app`
role that owns the application database. Only the production stack mounts
`scripts/postgres-init`; the dev container does not need an application-role
password or `.env.production.local`.

Test database cleanup runs against the dev container only; see [testing.md](testing.md).

- `scripts/postgres-init/01-app-role.sh` creates the role from `APP_DB_PASSWORD`
  on **first initialization only**. The postgres image skips
  `/docker-entrypoint-initdb.d` once the volume holds a database, so setting
  that variable later does nothing. Same trap as `POSTGRES_PASSWORD`, which
  `initdb` reads and nothing else — editing it on a populated volume is
  silently ignored, and the role's password changes only via `ALTER ROLE`.
- `scripts/check-db-credential.sh` runs from `docker-entrypoint.sh` before
  migrations and aborts startup when `DATABASE_URL` carries the published
  default. It is **not** a `${APP_DB_PASSWORD:?}` guard in `docker-compose.yml`:
  Compose interpolates the whole file before selecting services, so a required
  variable there also blocks `docker compose up -d postgres`, `ps`, `logs` and
  `down` (measured). Checking the connection string also catches the operator
  who sets `APP_DB_PASSWORD` and forgets to update `DATABASE_URL`.
- Migrating a pre-existing instance is a manual step; the procedure is
  "Separating the application database role" in the README. The trap it
  documents is the one to remember: databases and tablespaces are shared
  objects, so `REASSIGN OWNED BY` retitles every database that role owns
  instance-wide — dev and test included — from ANY database it is run in.
  Connecting to the right one confines only the objects inside it. Where the
  role owns databases you mean to leave alone, move ownership by hand instead.
