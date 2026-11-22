import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createAccount, createBook, createPayee, createTransactionWithSplits, createUser,
  resetTestDatabase, setupTestDatabase,
} from "../helpers/db-utils";
import { insert, rows, scalar } from "../helpers/sql";
import { workerDatabasePath } from "../helpers/test-database";
import { rustBinary } from "../helpers/rust-binaries";

const run = promisify(execFile);
const CLI = rustBinary("ledger-cli");

/** Runs `ledger-cli merge-payee-case` on this worker's database; a failure resolves with its code. */
async function merge(...args: string[]) {
  try {
    const { stdout, stderr } = await run(CLI, ["merge-payee-case", ...args], {
      env: { ...process.env, DATABASE_PATH: workerDatabasePath(), DATABASE_URL: "" },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}

describe("ledger-cli merge-payee-case", () => {
  beforeAll(async () => { await setupTestDatabase(); });
  beforeEach(async () => { await resetTestDatabase(); });

  async function fixture(bookId = 1) {
    const checking = await createAccount({ name: "Checking", type: "asset", bookId });
    const food = await createAccount({ name: "Food", type: "expense", bookId });
    const spend = (payeeId: number, date: string) =>
      createTransactionWithSplits({
        date, payeeId, bookId,
        splits: [{ accountId: food.id, amount: 100 }, { accountId: checking.id, amount: -100 }],
      });
    // The database refuses ASCII case variants, so these differ by a
    // non-ASCII letter, which the merge folds as the app does.
    const paypal = await createPayee({ name: "Café Rouge", bookId });
    const paypalLower = await createPayee({ name: "CAFÉ ROUGE", bookId });
    const groupon = await createPayee({ name: "Éclair", bookId });
    const grouponCaps = await createPayee({ name: "éclair", bookId });
    const alone = await createPayee({ name: "Alone", bookId });
    for (const date of ["2026-01-01", "2026-01-02", "2026-01-03"]) await spend(paypal.id, date);
    await spend(paypalLower.id, "2026-01-04");
    await spend(groupon.id, "2026-01-05");
    await spend(grouponCaps.id, "2026-01-06");
    await spend(grouponCaps.id, "2026-01-07");
    await spend(alone.id, "2026-01-08");
    return { checking, food, paypal, paypalLower, groupon, grouponCaps, alone };
  }

  const payeeNames = (bookId = 1) =>
    rows<{ name: string }>("SELECT name FROM payees WHERE book_id = $1 ORDER BY name", [bookId]);

  it("prints the plan and changes nothing without --apply", async () => {
    await fixture();
    const result = await merge("--book-id", "1");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("2 group(s)");
    expect(result.stdout).toContain('keep "Café Rouge"');
    expect(result.stdout).toContain("DRY RUN");
    expect(await payeeNames()).toHaveLength(5);
  });

  it("merges each group into the kept spelling, the one with more transactions by default", async () => {
    const f = await fixture();
    const rule = await insert<{ id: number }>("recurring_rules", {
      bookId: 1, name: "Monthly", payeeId: f.paypalLower.id, frequency: "monthly",
      startDate: "2026-01-01", nextDate: "2026-02-01", createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const result = await merge("--book-id", "1", "--apply");
    expect(result.code, result.stderr).toBe(0);
    expect(await payeeNames()).toEqual([{ name: "Alone" }, { name: "Café Rouge" }, { name: "éclair" }]);
    expect(await scalar("SELECT COUNT(*) FROM transactions WHERE payee_id = $1", [f.paypal.id])).toBe(4);
    expect(await scalar("SELECT COUNT(*) FROM transactions WHERE payee_id = $1", [f.grouponCaps.id])).toBe(3);
    expect(await scalar("SELECT payee_id FROM recurring_rules WHERE id = $1", [rule.id])).toBe(f.paypal.id);
  });

  it("keeps the spelling that --keep names", async () => {
    const f = await fixture();
    const result = await merge("--book-id", "1", "--keep", "Éclair", "--apply");
    expect(result.code, result.stderr).toBe(0);
    expect(await payeeNames()).toEqual([{ name: "Alone" }, { name: "Café Rouge" }, { name: "Éclair" }]);
    expect(await scalar("SELECT COUNT(*) FROM transactions WHERE payee_id = $1", [f.groupon.id])).toBe(3);
  });

  it("refuses a --keep that is not a spelling of a group, and writes nothing", async () => {
    await fixture();
    for (const keep of ["ÉCLAIR", "Alone", "Nobody"]) {
      const result = await merge("--book-id", "1", "--keep", keep, "--apply");
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(keep);
    }
    expect(await payeeNames()).toHaveLength(5);
  });

  it("leaves the other books as they are", async () => {
    await createUser({ username: "owner2" });
    await createBook({ name: "Other", userId: 2 });
    await fixture(1);
    await fixture(2);
    expect((await merge("--book-id", "1", "--apply")).code).toBe(0);
    expect(await payeeNames(2)).toHaveLength(5);
  });

  it("refuses a book that does not exist", async () => {
    const result = await merge("--book-id", "99", "--apply");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("99");
  });

  it("says when a book has nothing to merge", async () => {
    await createPayee({ name: "Solo" });
    const result = await merge("--book-id", "1");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("0 group(s)");
  });
});
