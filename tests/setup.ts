import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, vi } from "vitest";

const workerId =
  process.env.VITEST_POOL_ID || process.env.VITEST_WORKER_ID || "0";

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = `postgresql://counterpoise:counterpoise@localhost:5432/counterpoise_test_${workerId}`;
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});
