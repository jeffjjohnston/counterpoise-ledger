import { afterEach, beforeEach, expect, vi } from "vitest";
import { staleFolds } from "./helpers/sql";
import { workerDatabasePath } from "./helpers/test-database";

// DOM-specific configuration lives in setup-dom.ts.

// Every process that a test starts uses this worker's file. DATABASE_URL
// would make the server refuse to start (an unconverted install).
process.env.DATABASE_PATH = workerDatabasePath();
delete process.env.DATABASE_URL;
// The key of the stored Plaid access tokens: a server without one stores no
// token. A fixed test value; never a deployment's.
process.env.PLAID_TOKEN_KEY ??= "dGVzdC1vbmx5LXBsYWlkLXRva2VuLWtleS0zMmJ5dGU=";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Every write path stores each `*_fold` column beside the column it folds
// (guides/patterns-and-gotchas.md). A stale fold after a test is a write path
// that does not.
afterEach(() => {
  expect(staleFolds(), "folded columns that differ from their column").toEqual([]);
});
