import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createBook, createUser, resetTestDatabase, setupTestDatabase } from "../helpers/db-utils";
import { exec } from "../helpers/sql";

const payee = (bookId: number, name: string) =>
  exec(
    "INSERT INTO payees (book_id, name, name_fold, created_at) VALUES ($1, $2, $3, '2026-10-12 00:00:00')",
    [bookId, name, name.toLowerCase()],
  );

/**
 * A payee name matches without letter case. The index is the backstop for
 * ASCII case (SQLite NOCASE); find_payee_by_name() covers Unicode case.
 */
describe("payee case index", () => {
  beforeAll(async () => { await setupTestDatabase(); });
  beforeEach(async () => { await resetTestDatabase(); });

  it("refuses a second payee that differs only by ASCII letter case in one book", async () => {
    await payee(1, "PayPal");
    await expect(payee(1, "Paypal")).rejects.toThrow(/UNIQUE/);
    await expect(payee(1, "PAYPAL")).rejects.toThrow(/UNIQUE/);
  });

  it("allows the same name in another book", async () => {
    await createUser({ username: "owner2" });
    await createBook({ name: "Other", userId: 2 });
    await payee(1, "PayPal");
    await payee(2, "Paypal");
  });
});
