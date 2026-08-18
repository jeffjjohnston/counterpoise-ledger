import { vi } from "vitest";
import { db } from "./db-utils";

// Re-export everything from db-utils so existing vitest imports still work
export {
  setupTestDatabase,
  resetTestDatabase,
  createAccount,
  createBook,
  createInvestmentLot,
  createTransactionWithSplits,
  createRecurringRule,
  createPayee,
  createSecurity,
  createInvestmentSplit,
  createSecurityPrice,
  createPlaidToken,
  createPlaidAccount,
  createPlaidReconciliation,
} from "./db-utils";

/**
 * Mock `authenticateBookRequest` so API route tests bypass
 * real session / meta-DB lookups and use the test database directly.
 *
 * Call this in a `vi.mock("@/lib/api-auth", ...)` block, e.g.:
 *
 *   vi.mock("@/lib/api-auth", () => mockApiAuth());
 */
export function mockApiAuth() {
  return {
    isError: (result: unknown): result is { error: unknown } =>
      typeof result === "object" && result !== null && "error" in result,
    authenticateBookRequest: vi.fn().mockResolvedValue({
      db,
      bookId: 1,
      userId: 1,
      book: { id: 1, userId: 1, name: "Test Book", upcomingDays: 30, createdAt: new Date(), updatedAt: new Date() },
    }),
    authenticateRequest: vi.fn().mockResolvedValue({ userId: 1 }),
  };
}
