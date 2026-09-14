import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";
import { newTestRunId } from "./db/test-db-name";

// ONE RUN ID FOR THE WHOLE RUN, generated here because this file is evaluated
// once, in the main process. A worker cannot generate it: vitest rebuilds the
// module graph for each test FILE, so an id made in module scope there would
// give every file its own database instead of every run.
//
// Written to both places on purpose. `test.env` is what reaches the forked
// workers; `process.env` is what reaches anything else this process runs.
const testRunId = newTestRunId();
process.env.COUNTERPOISE_TEST_RUN_ID = testRunId;

// New persistence suites belong in this list or tests/api/. Pure calculations
// and schemas stay runnable without PostgreSQL.
const databaseTests = [
  "tests/db/session-hash-migration.test.ts",
  "tests/db/database-lease.test.ts",
  "tests/db/concurrent-runs.test.ts",
  "tests/api/**/*.test.ts",
  "tests/db/backfill-dividend-account-ids.test.ts",
  "tests/db/book-scoped-composite-fks.test.ts",
  "tests/db/list-books-script.test.ts",
  "tests/db/lot-schema.test.ts",
  "tests/db/timezone.test.ts",
  "tests/import/account-import-integration.test.ts",
  "tests/import/full-import.test.ts",
  "tests/import/lot-rebuild-ordering.test.ts",
  "tests/import/overwrite.test.ts",
  "tests/import/reminders.test.ts",
  "tests/import/transactions.test.ts",
  "tests/lib/accounts.test.ts",
  "tests/lib/advisory-lock.test.ts",
  "tests/lib/books.test.ts",
  "tests/lib/floating-transactions.test.ts",
  "tests/lib/investments-latest-prices.test.ts",
  "tests/lib/investments-ordering.test.ts",
  "tests/lib/issue-reports.test.ts",
  "tests/lib/lots-backfill.test.ts",
  "tests/lib/lots-db.test.ts",
  "tests/lib/payees.test.ts",
  "tests/lib/plaid-auto-match.test.ts",
  "tests/lib/plaid-reconcile.test.ts",
  "tests/lib/plaid-sync.test.ts",
  "tests/lib/plaid-tokens.test.ts",
  "tests/lib/plaid-transactions.test.ts",
  "tests/lib/positions-lots.test.ts",
  "tests/lib/realized-gains.test.ts",
  "tests/lib/recurring-processing.test.ts",
  "tests/lib/recurring-rules.test.ts",
  "tests/lib/registration.test.ts",
  "tests/lib/reports-queries.test.ts",
  "tests/lib/search.test.ts",
  "tests/lib/securities.test.ts",
  "tests/lib/security-prices.test.ts",
  "tests/lib/session.test.ts",
  "tests/lib/transactions-lots.test.ts",
  "tests/lib/transactions-query.test.ts",
  "tests/lib/transactions.test.ts",
  "tests/mcp/mcp-account-tools.test.ts",
  "tests/mcp/mcp-book-tools.test.ts",
  "tests/mcp/mcp-issue-report-tools.test.ts",
  "tests/mcp/mcp-payee-tools.test.ts",
  "tests/mcp/mcp-plaid-reconcile-tools.test.ts",
  "tests/mcp/mcp-plaid-tools.test.ts",
  "tests/mcp/mcp-recurring-tools.test.ts",
  "tests/mcp/mcp-security-price-tools.test.ts",
  "tests/mcp/mcp-tools.test.ts",
  "tests/mcp/mcp-write-tools.test.ts",
  "tests/scripts/sweep-test-databases.test.ts",
];
const domTests = ["tests/**/*.test.tsx", "tests/lib/utils.test.ts", "tests/lib/posthog-client.test.ts"];

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "./") } },
  test: {
    globals: true,
    env: { COUNTERPOISE_TEST_RUN_ID: testRunId },
    pool: "forks",
    // ONE WORKER COUNT FOR EVERY ENVIRONMENT, automation included. This used
    // to branch, so the arm that ran in CI was not the arm that ran locally —
    // and that difference is what hid a contention bug rather than any single
    // number being wrong. The suite's process helpers share one database, and
    // more workers meant lock waits long enough to time a case out, in the one
    // configuration automation never exercised.
    //
    // So the arms are joined rather than the local one retuned. Raising this
    // is a change to what has actually been proven green; move both or neither.
    maxWorkers: 2,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    setupFiles: ["./tests/setup.ts"],
    projects: [
      { extends: true, test: {
        name: "node", environment: "node",
        include: ["tests/**/*.test.ts"],
        exclude: [...configDefaults.exclude, ...databaseTests, ...domTests],
      } },
      { extends: true, test: {
        name: "database", environment: "node", include: databaseTests,
      } },
      { extends: true, test: {
        name: "dom", environment: "jsdom", include: domTests,
        setupFiles: ["./tests/setup.ts", "./tests/setup-dom.ts"],
      } },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: [
        "app/**/*.{ts,tsx}",
        "components/**/*.{ts,tsx}",
        "db/**/*.ts",
        "lib/**/*.ts",
        "mcp/**/*.ts",
        "scripts/**/*.ts",
      ],
      exclude: [
        "app/**/*.test.{ts,tsx}",
        "components/**/*.test.{ts,tsx}",
        "db/migrations/**",
        "tests/**",
      ],
    },
  },
});
