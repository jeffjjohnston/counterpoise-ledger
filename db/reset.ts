/**
 * Drops every table and the migration history, then runs the migrations from
 * the start. `npm run db:seed` (no args) runs this before the Rust seed
 * (`ledger-cli seed`), via db/seed-cli.ts, because Drizzle is the only
 * migrator.
 *
 * **Declarations only — no top-level side effects.** The CLI and its
 * main-module guard live in db/seed-cli.ts; see guides/patterns-and-gotchas.md.
 */
import { runMigrations, getSqlClient_raw } from "./index";

export async function resetDatabase() {
  // Drop both public (tables) and drizzle (migration metadata), otherwise
  // Drizzle thinks the migrations already ran.
  const sqlClient = getSqlClient_raw();
  await sqlClient`DROP SCHEMA IF EXISTS drizzle CASCADE`;
  await sqlClient`DROP SCHEMA IF EXISTS public CASCADE`;
  await sqlClient`CREATE SCHEMA public`;

  // Clear cached instances so migrations re-run
  delete globalThis.__counterpoiseDrizzle;
  delete globalThis.__counterpoiseMigrated;

  await runMigrations();
}
