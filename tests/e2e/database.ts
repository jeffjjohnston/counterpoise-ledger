import { resolve } from "node:path";

/**
 * The database file of the browser tests: `.e2e/counterpoise.db`, which the
 * Playwright web server creates and migrates when it starts. Not under
 * `test-results/`, which Playwright empties while the server runs.
 */
export function e2eDatabasePath(): string {
  return process.env.E2E_DATABASE_PATH ?? resolve(".e2e/counterpoise.db");
}
