import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { verifyPassword } from "../helpers/password";
import { createAccount, createBook, resetTestDatabase, setupTestDatabase } from "../helpers/db-utils";
import { count as countWhere, row, scalar, script } from "../helpers/sql";
import { workerDatabasePath } from "../helpers/test-database";
import { dumpTables as dump } from "../helpers/table-dump";

const run = promisify(execFile);
const CLI = path.resolve("rust-api/target/debug/ledger-cli");
const SEED_TIMEOUT = 180_000;

/** The date that the seed tests pin. The household rows at this date are the rows of the fixed 2023-2025 seed. */
const PINNED_TODAY = "2025-12-31";

/** Run the Rust seed against this worker's database, in this process's zone. */
async function rustSeed(...args: string[]) {
  // The pin goes first, so that a flag with a missing value still reads the end of the list.
  const pinned = args.includes("--today") ? args : ["--today", PINNED_TODAY, ...args];
  return run(CLI, ["seed", ...pinned], {
    env: {
      ...process.env,
      DATABASE_PATH: workerDatabasePath(),
      DATABASE_URL: "",
      TZ: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  });
}

async function count(table: string, bookId: number) {
  return countWhere(table, "book_id = $1", [bookId]);
}

// The seed writes dates relative to `--today`. The tests pin it, so the
// counts are fixed and two runs write the same rows.
describe("the Rust seed", () => {
  beforeAll(async () => { await setupTestDatabase(); }, 120_000);
  beforeEach(async () => { await resetTestDatabase(); });

  it("writes the sample dataset into an existing book, the same rows each time", async () => {
    const { stdout } = await rustSeed("--book-id", "1");
    expect(stdout).toContain("Found book 'Test Book' (id: 1)");
    expect(stdout).toContain("All transactions balance");
    const first = await dump();
    expect(first.transactions).toHaveLength(2235);
    expect(first.accounts).toHaveLength(62);
    expect(first.payees).toHaveLength(46);
    expect(first.securities).toHaveLength(4);
    expect(first.investment_lot_allocations.length).toBeGreaterThan(0);
    expect(first.plaid_transaction_reconciliation).toHaveLength(6);
    const unbalanced = await scalar<number>(`
      SELECT CAST(COUNT(*) AS integer) AS unbalanced FROM (
        SELECT transaction_id FROM transaction_splits GROUP BY transaction_id HAVING SUM(amount) <> 0
      ) t`);
    expect(unbalanced).toBe(0);

    await resetTestDatabase();
    await rustSeed("--book-id", "1");
    expect(await dump()).toEqual(first);
  }, SEED_TIMEOUT);

  it("creates the admin user and the Family Finances book without --book-id", async () => {
    const { stdout } = await rustSeed();
    const book = await row<{ id: number }>("SELECT id FROM books WHERE name = $1", ["Family Finances"]);
    expect(stdout).toContain(
      `Created user 'admin' (password: 'password') and book 'Family Finances' (id: ${book.id})`
    );
    expect(await count("transactions", book.id)).toBe(2235);

    const admin = await row<{ passwordHash: string }>(
      "SELECT password_hash FROM users WHERE username = $1", ["admin"]
    );
    expect(await verifyPassword("password", admin.passwordHash)).toBe(true);
  }, SEED_TIMEOUT);

  it("replaces the rows of the target book and leaves other books alone", async () => {
    const other = await createBook({ name: "Other" });
    await createAccount({ bookId: other.id, name: "Untouchable", type: "asset" });

    await rustSeed("--book-id", "1");
    const first = await count("transactions", 1);
    await rustSeed("--book-id", "1");

    expect(await count("transactions", 1)).toBe(first);
    expect(await count("accounts", 1)).toBe(62);
    expect(await count("accounts", other.id)).toBe(1);
  }, SEED_TIMEOUT);

  // `npm run db:seed -- --book-id 1` runs `ledger-cli seed --reset --book-id 1`.
  it("keeps the database when --reset comes with --book-id", async () => {
    const other = await createBook({ name: "Other" });
    await createAccount({ bookId: other.id, name: "Untouchable", type: "asset" });

    const { stdout } = await rustSeed("--reset", "--book-id", "1");

    expect(stdout).toContain("--reset applies only to a full seed");
    expect(await count("accounts", 1)).toBe(62);
    expect(await count("accounts", other.id)).toBe(1);
  }, SEED_TIMEOUT);

  it("refuses a missing or unknown book", async () => {
    await expect(rustSeed("--book-id")).rejects.toMatchObject({
      code: 1, stderr: expect.stringContaining("--book-id requires a numeric argument"),
    });
    await expect(rustSeed("--book-id", "two")).rejects.toMatchObject({
      code: 1, stderr: expect.stringContaining('invalid book ID "two"'),
    });
    await expect(rustSeed("--book-id", "999")).rejects.toMatchObject({
      code: 1, stderr: expect.stringContaining("book 999 not found"),
    });
    await expect(rustSeed("--book-id", "1", "--dataset", "nope")).rejects.toMatchObject({
      code: 1, stderr: expect.stringContaining('unknown dataset "nope"'),
    });
    await expect(rustSeed("--book-id", "1", "--today", "tomorrow")).rejects.toMatchObject({
      code: 1, stderr: expect.stringContaining('invalid date "tomorrow"'),
    });
  });

  it("writes the single dataset with --dataset single", async () => {
    const { stdout } = await rustSeed("--book-id", "1", "--dataset", "single");
    expect(stdout).toContain("with the Single homeowner dataset");
    const first = await dump();
    expect(first.accounts).toHaveLength(38);
    expect(first.payees).toHaveLength(23);
    expect(first.securities).toHaveLength(3);
    expect(first.recurring_rules).toHaveLength(7);
    expect(first.plaid_transaction_reconciliation).toHaveLength(6);
    expect(first.investment_lot_allocations.length).toBeGreaterThan(0);
    const latest = await scalar<string>("SELECT MAX(date) AS latest FROM transactions WHERE book_id = 1");
    expect(latest <= PINNED_TODAY).toBe(true);

    await resetTestDatabase();
    await rustSeed("--book-id", "1", "--dataset", "single");
    expect(await dump()).toEqual(first);
  }, SEED_TIMEOUT);

  it("names a full single seed after the dataset", async () => {
    await rustSeed("--dataset", "single");
    expect(await countWhere("books", "name = $1", ["Demo Book - Single"])).toBe(1);
  }, SEED_TIMEOUT);

  it("exits 1 and keeps the book as it was when a late step fails", async () => {
    await createAccount({ name: "Before the seed", type: "asset" });
    // The Plaid rows come after every transaction, so this trigger fails the
    // seed late in the run.
    await script(`CREATE TRIGGER refuse_seed_token BEFORE INSERT ON plaid_tokens
      BEGIN SELECT RAISE(ABORT, 'refused for the test'); END;`);
    try {
      await expect(rustSeed("--book-id", "1")).rejects.toMatchObject({
        code: 1, stderr: expect.stringContaining("Seed failed"),
      });
    } finally {
      await script("DROP TRIGGER IF EXISTS refuse_seed_token");
    }
    expect(await count("transactions", 1)).toBe(0);
    expect(await count("accounts", 1)).toBe(1);
  }, SEED_TIMEOUT);
});
