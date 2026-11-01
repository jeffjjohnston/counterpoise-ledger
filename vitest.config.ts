import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";
import { newTestRunId } from "./tests/helpers/test-database";

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
//
// Every tool suite runs over HTTP. Both transports reach the same tool
// dispatcher, so the stdio run has only the suites that cross the stdio
// adapter: its own lifecycle and key checks, the book roles, and one call of
// each result kind. guides/mcp-server.md has the coverage table.
const rustMcpHttpTests = [
  "tests/mcp/manifest.test.ts",
  "tests/mcp/mcp-*.test.ts",
  "tests/mcp/rust-transport.test.ts",
];
const rustMcpStdioTests = [
  "tests/mcp/rust-stdio.test.ts",
  "tests/mcp/mcp-book-access.test.ts",
  "tests/mcp/mcp-transports.test.ts",
];
const rustMcpTests =
  process.env.COUNTERPOISE_MCP_TRANSPORT === "stdio" ? rustMcpStdioTests : rustMcpHttpTests;
// Every Rust MCP suite, for the node project to leave out: a plain `npm test`
// runs none of them, whatever the transport lists hold.
const allRustMcpTests = [...rustMcpHttpTests, ...rustMcpStdioTests];

// New persistence suites belong in this list. They need a SQLite file that
// `ledger-cli migrate` makes (tests/helpers/test-database.ts). Pure
// calculations and schemas stay runnable without it.
const databaseTests = [
  "tests/db/book-change-marks.test.ts",
  "tests/db/book-members.test.ts",
  "tests/db/reset-test-database.test.ts",
  "tests/db/book-scoped-composite-fks.test.ts",
  "tests/db/book-reference-triggers.test.ts",
  "tests/db/weekly-review-schema.test.ts",
  "tests/db/typesafe-entry-schema.test.ts",
  "tests/db/payee-case-index.test.ts",
  "tests/db/lot-schema.test.ts",
  "tests/db/typesafe-report.test.ts",
  ...(process.env.COUNTERPOISE_HTTP_SERVER ? ["tests/http/**/*.test.ts"] : []),
  ...(process.env.COUNTERPOISE_MCP_TRANSPORT ? rustMcpTests : []),
];
// The suites that do not apply when the HTTP tests run against the Worker
// (`COUNTERPOISE_HTTP_SERVER=worker`).
const notOnWorker = process.env.COUNTERPOISE_HTTP_SERVER === "worker" ? [
  // Cloudflare compresses at its edge, so the object never compresses, and
  // `wrangler dev` streams a response without a Content-Length.
  "tests/http/compression.test.ts",
] : [];
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
    globalSetup: ["./tests/global-setup.ts"],
    projects: [
      { extends: true, test: {
        name: "node", environment: "node",
        include: ["tests/**/*.test.ts"],
        exclude: [...configDefaults.exclude, ...databaseTests, ...domTests, "tests/http/**/*.test.ts", ...allRustMcpTests],
      } },
      { extends: true, test: {
        name: "database", environment: "node", include: databaseTests,
        exclude: [...configDefaults.exclude, ...notOnWorker],
      } },
      { extends: true, test: {
        name: "dom", environment: "jsdom", include: domTests,
        setupFiles: ["./tests/setup.ts", "./tests/setup-dom.ts"],
      } },
    ],
    coverage: {
      provider: "v8",
      // json-summary feeds scripts/coverage-summary.mjs, which CI writes to the
      // job summary. The HTML report is the artifact CI uploads.
      reporter: ["text", "json", "json-summary", "html"],
      include: [
        "app/**/*.{ts,tsx}",
        "components/**/*.{ts,tsx}",
        "lib/**/*.ts",
        "scripts/**/*.ts",
      ],
      exclude: [
        // The generated WASM bindings: core-bytes.ts is one base64 string and
        // the declarations hold no code, so they only move the totals.
        "lib/wasm/generated/**",
        "**/*.d.ts",
        "app/**/*.test.{ts,tsx}",
        "components/**/*.test.{ts,tsx}",
        "tests/**",
      ],
    },
  },
});
