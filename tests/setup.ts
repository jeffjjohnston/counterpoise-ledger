import { afterEach, beforeEach, vi } from "vitest";
import { workerDatabaseUrl } from "./helpers/database-safety";

// DOM-specific configuration lives in setup-dom.ts.

process.env.DATABASE_URL = workerDatabaseUrl();

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});
