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

// The MCP suites run against the Rust server over the transport that
// COUNTERPOISE_MCP_TRANSPORT names (npm run test:mcp:http or test:mcp:stdio).
// They need its binary, so a plain `npm test` leaves them out, as it leaves
// out tests/http.
const rustMcpTests = [
  "tests/mcp/manifest.test.ts",
  "tests/mcp/mcp-*.test.ts",
  "tests/mcp/rust-stdio.test.ts",
  "tests/mcp/rust-transport.test.ts",
];

// New persistence suites belong in this list. Pure calculations
// and schemas stay runnable without PostgreSQL.
const databaseTests = [
  "tests/db/book-change-notifications.test.ts",
  "tests/db/book-members.test.ts",
  "tests/db/reset-test-database.test.ts",
  "tests/db/session-hash-migration.test.ts",
  "tests/db/database-lease.test.ts",
  "tests/db/concurrent-runs.test.ts",
  "tests/db/backfill-dividend-account-ids.test.ts",
  "tests/db/book-scoped-composite-fks.test.ts",
  "tests/db/list-books-script.test.ts",
  "tests/db/lot-schema.test.ts",
  "tests/db/timezone.test.ts",
  "tests/lib/investments-latest-prices.test.ts",
  "tests/lib/investments-ordering.test.ts",
  "tests/lib/lots-backfill.test.ts",
  "tests/lib/lots-db.test.ts",
  "tests/lib/payees.test.ts",
  "tests/scripts/sweep-test-databases.test.ts",
  ...(process.env.COUNTERPOISE_HTTP_SERVER ? ["tests/http/**/*.test.ts"] : []),
  ...(process.env.COUNTERPOISE_MCP_TRANSPORT ? rustMcpTests : []),
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
        exclude: [...configDefaults.exclude, ...databaseTests, ...domTests, "tests/http/**/*.test.ts", ...rustMcpTests],
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
