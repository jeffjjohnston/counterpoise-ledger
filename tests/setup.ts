import { afterEach, beforeEach, vi } from "vitest";
import { workerDatabasePath } from "./helpers/test-database";

// DOM-specific configuration lives in setup-dom.ts.

// Every process that a test starts uses this worker's file. DATABASE_URL
// would make the server refuse to start (an unconverted install).
process.env.DATABASE_PATH = workerDatabasePath();
delete process.env.DATABASE_URL;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});
