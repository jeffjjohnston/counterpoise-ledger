import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createAccount,
  createBook,
  createTransactionWithSplits,
  resetTestDatabase,
  setupTestDatabase,
} from "../helpers/db-utils";
import { count as countWhere, rows, script } from "../helpers/sql";
import { workerDatabasePath } from "../helpers/test-database";
import { dumpTables } from "../helpers/table-dump";

const run = promisify(execFile);
const CLI = path.resolve("rust-api/target/debug/ledger-cli");
const TIMEOUT = 60_000;
const FIXTURES = ["moneydance-sample.json", "moneydance-edge-cases.json"];

function fixturePath(name: string) {
  return path.resolve("tests/fixtures", name);
}

/** Run the Rust importer against this worker's database, in this process's zone. */
async function rustImport(...args: string[]) {
  return run(CLI, ["import-moneydance", ...args], {
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

/** The row count of each table. */
async function counts() {
  return Object.fromEntries(
    Object.entries(await dumpTables()).map(([table, rows]) => [table, rows.length])
  );
}

// The TypeScript importer was the reference for `ledger-cli
// import-moneydance` until the TypeScript server was retired; this suite held
// both to the same rows. The import writes dates relative to today, so a
// recorded dump would change every day. The suite checks the rows that matter
// and that each run writes the same rows.
describe("Moneydance import with the Rust CLI", () => {
  beforeAll(async () => { await setupTestDatabase(); }, 120_000);
  beforeEach(async () => { await resetTestDatabase(); });

  for (const fixture of FIXTURES) {
    for (const flags of [[], ["--no-inactive", "--no-hidden"]]) {
      it(`writes the same rows each time for ${fixture} ${flags.join(" ") || "with every account"}`, async () => {
        const { stdout } = await rustImport(fixturePath(fixture), "--book-id", "1", ...flags);
        expect(stdout).toContain("Import completed successfully");
        const first = await dumpTables();
        expect(first.transactions.length).toBeGreaterThan(5);
        expect(first.investment_lots.length).toBeGreaterThan(0);
        expect(first.recurring_rules.length).toBeGreaterThan(0);

        await resetTestDatabase();
        await rustImport(fixturePath(fixture), "--book-id", "1", ...flags);
        expect(await dumpTables()).toEqual(first);
      }, TIMEOUT);
    }

    it(`leaves inactive and hidden accounts out of ${fixture} when asked`, async () => {
      await rustImport(fixturePath(fixture), "--book-id", "1");
      const every = await count("accounts", 1);
      await resetTestDatabase();
      await rustImport(fixturePath(fixture), "--book-id", "1", "--no-inactive", "--no-hidden");
      expect(await count("accounts", 1)).toBeLessThanOrEqual(every);
    }, TIMEOUT);
  }

  it("covers the edge cases that the fixture sets up", async () => {
    await rustImport(fixturePath("moneydance-edge-cases.json"), "--book-id", "1");
    const names = (await rows<{ name: string }>("SELECT name FROM accounts ORDER BY id")).map((row) => row.name);
    expect(names).toEqual(expect.arrayContaining(["Auto:Fuel", "Legacy:Dues", "Brokerage - Cash", "Imported Balance"]));
    expect(names).not.toContain("Unknown Type");
    const payees = (await rows<{ name: string }>("SELECT name FROM payees ORDER BY id")).map((row) => row.name);
    expect(payees).toEqual(expect.arrayContaining(["Employer's Payroll", "City Garage", "Bad Date Store"]));
    // Two security accounts hold AAA, so it is one security.
    const symbols = (await rows<{ symbol: string }>("SELECT symbol FROM securities ORDER BY id")).map((row) => row.symbol);
    expect(symbols).toEqual(["AAA", "BBB", "Gamma Growth", "DDD"]);
    const ratios = await rows<{ n: number; d: number }>(
      "SELECT split_numerator AS n, split_denominator AS d FROM investment_splits WHERE action = $1 ORDER BY id", ["split"]
    );
    expect(ratios).toEqual([{ n: 2, d: 1 }, { n: 2, d: 1 }, { n: 1, d: 2 }]);
    // Every reminder with a known frequency and imported accounts, and no bad date.
    expect(await count("recurring_rules", 1)).toBe(5);
  }, TIMEOUT);

  // Critical Accounting Rule 1 holds for every imported row, not only for the
  // rows that a route writes.
  for (const fixture of FIXTURES) {
    it(`writes no unbalanced transaction for ${fixture}`, async () => {
      await rustImport(fixturePath(fixture), "--book-id", "1");
      const unbalanced = await rows<{ description: string; total: number }>(`
        SELECT t.description, SUM(s.amount) AS total
        FROM transactions t JOIN transaction_splits s ON s.transaction_id = t.id
        WHERE t.book_id = $1 GROUP BY t.id HAVING SUM(s.amount) <> 0`, [1]);
      expect(unbalanced).toEqual([]);
    }, TIMEOUT);
  }

  // A Moneydance buy with reinvest="true" is a DRIP: one transaction with a
  // buy split and a dividend split. Its cash sum is 0, so the investment leg
  // comes from the security, not from the cash.
  it("imports a reinvested buy as one balanced transaction", async () => {
    await rustImport(fixturePath("moneydance-edge-cases.json"), "--book-id", "1");
    const [transaction] = await rows<{ id: number }>(
      "SELECT id FROM transactions WHERE description = $1", ["AAA Reinvested"]
    );
    const legs = await rows<{ name: string; amount: number }>(`
      SELECT a.name, s.amount FROM transaction_splits s JOIN accounts a ON a.id = s.account_id
      WHERE s.transaction_id = $1 ORDER BY s.amount DESC`, [transaction.id]);
    // G = 2 shares at 50.00 = 10000. D = 10000. R = D - G = 0, so no cash leg.
    expect(legs).toEqual([
      { name: "Brokerage", amount: 10000 },
      { name: "Dividends", amount: -10000 },
    ]);
    const splits = await rows<{ action: string; sharesMicros: number; priceMicros: number }>(`
      SELECT action, shares_micros, price_micros FROM investment_splits
      WHERE transaction_id = $1 ORDER BY action`, [transaction.id]);
    expect(splits).toEqual([
      { action: "buy", sharesMicros: 2_000_000, priceMicros: 50_000_000 },
      { action: "dividend", sharesMicros: 0, priceMicros: 0 },
    ]);
  }, TIMEOUT);

  // A Moneydance dividend with shares (a DRIP) is one transaction, as the form
  // writes it: a dividend split and a buy split, the investment leg G + F,
  // the income leg -D, and the cash leg D - G - F only when it is not 0.
  it("imports a reinvested dividend as one transaction", async () => {
    const { stdout } = await rustImport(fixturePath("moneydance-edge-cases.json"), "--book-id", "1", "--verbose");
    expect(stdout).toContain("DIVIDEND REINVESTMENT AAA Dividend");
    expect(stdout).not.toContain("split into 2 txns");
    const drips = await rows<{ id: number }>(`
      SELECT t.id FROM transactions t
      WHERE t.description = $1
        AND EXISTS (SELECT 1 FROM investment_splits i WHERE i.transaction_id = t.id AND i.action = 'buy')`,
    ["AAA Dividend"]);
    expect(drips).toHaveLength(1);
    expect(await rows("SELECT id FROM transactions WHERE description LIKE $1", ["AAA Dividend (%"])).toEqual([]);
    const legs = await rows<{ name: string; amount: number }>(`
      SELECT a.name, s.amount FROM transaction_splits s JOIN accounts a ON a.id = s.account_id
      WHERE s.transaction_id = $1 ORDER BY s.amount DESC`, [drips[0].id]);
    // D = 5000 buys 1 share at 50.00 (G = 5000), so there is no cash leg.
    expect(legs).toEqual([
      { name: "Brokerage", amount: 5000 },
      { name: "Dividends", amount: -5000 },
    ]);
    const splits = await rows<{ action: string; sharesMicros: number; priceMicros: number }>(`
      SELECT action, shares_micros, price_micros FROM investment_splits
      WHERE transaction_id = $1 ORDER BY action`, [drips[0].id]);
    expect(splits).toEqual([
      { action: "buy", sharesMicros: 1_000_000, priceMicros: 50_000_000 },
      { action: "dividend", sharesMicros: 0, priceMicros: 0 },
    ]);
  }, TIMEOUT);

  // When --no-hidden leaves out the income account, the income leg of a
  // dividend or a reinvested buy has no account. The importer must refuse the
  // row, not write it without that leg.
  it("refuses an investment row whose income account was left out", async () => {
    const fixture = JSON.parse(await readFile(fixturePath("moneydance-edge-cases.json"), "utf8"));
    const dividends = fixture.all_items.find((item: { id?: string }) => item.id === "acct-dividends");
    dividends.hide = "y";
    const file = path.join(await mkdtemp(path.join(os.tmpdir(), "md-hidden-")), "export.json");
    await writeFile(file, JSON.stringify(fixture));

    const { stdout } = await rustImport(file, "--book-id", "1", "--no-hidden");
    expect(stdout).toContain("Unbalanced transaction");
    const unbalanced = await rows(`
      SELECT t.id FROM transactions t JOIN transaction_splits s ON s.transaction_id = t.id
      WHERE t.book_id = $1 GROUP BY t.id HAVING SUM(s.amount) <> 0`, [1]);
    expect(unbalanced).toEqual([]);
    const refused = await rows(
      "SELECT description FROM transactions WHERE description IN ($1, $2)",
      ["AAA Reinvested", "AAA Dividend"],
    );
    expect(refused).toEqual([]);
  }, TIMEOUT);

  it("writes the same rows each time the same file is imported twice", async () => {
    await rustImport(fixturePath("moneydance-edge-cases.json"), "--book-id", "1");
    await rustImport(fixturePath("moneydance-edge-cases.json"), "--book-id", "1");
    const expected = await dumpTables();

    await resetTestDatabase();
    await rustImport(fixturePath("moneydance-edge-cases.json"), "--book-id", "1");
    await rustImport(fixturePath("moneydance-edge-cases.json"), "--book-id", "1");
    expect(await dumpTables()).toEqual(expected);
  }, TIMEOUT);

  it("replaces the book's rows with --overwrite", async () => {
    await rustImport(fixturePath("moneydance-sample.json"), "--book-id", "1");
    const once = await counts();

    await rustImport(fixturePath("moneydance-sample.json"), "--book-id", "1");
    const { stdout } = await rustImport(fixturePath("moneydance-sample.json"), "--book-id", "1", "--overwrite");
    expect(stdout).toContain("Cleared existing book data");
    expect(await counts()).toEqual(once);
  }, TIMEOUT);

  it("keeps another book's rows and its Imported Balance account apart", async () => {
    const other = await createBook({ name: "Other" });
    const otherCash = await createAccount({ bookId: other.id, name: "Imported Balance", type: "expense" });
    const otherBank = await createAccount({ bookId: other.id, name: "Bank", type: "asset" });
    await createTransactionWithSplits({
      bookId: other.id,
      date: "2024-01-01",
      description: "Other book",
      splits: [
        { accountId: otherBank.id, amount: 100 },
        { accountId: otherCash.id, amount: -100 },
      ],
    });
    const before = await rows("SELECT * FROM transaction_splits WHERE book_id = $1 ORDER BY id", [other.id]);

    await rustImport(fixturePath("moneydance-sample.json"), "--book-id", "1");

    const offsets = await rows<{ bookId: number }>(`
      SELECT a.book_id FROM transaction_splits s JOIN accounts a ON a.id = s.account_id
      WHERE a.name = $1 AND s.book_id = $2`, ["Imported Balance", 1]);
    expect(offsets.length).toBeGreaterThan(0);
    expect(offsets.every((row) => row.bookId === 1)).toBe(true);
    expect(await rows("SELECT * FROM transaction_splits WHERE book_id = $1 ORDER BY id", [other.id])).toEqual(before);
    expect(await count("accounts", other.id)).toBe(2);
  }, TIMEOUT);

  it("writes nothing on a dry run", async () => {
    const before = await dumpTables();
    const { stdout, stderr } = await rustImport(
      fixturePath("moneydance-edge-cases.json"), "--book-id", "1", "--dry-run", "--overwrite"
    );
    expect(stdout).toContain("--overwrite ignored in dry-run mode");
    expect(stdout).toContain("Dry run completed successfully");
    expect(await dumpTables()).toEqual(before);
    // The fixture's malformed split ratio is an error, not an imported split.
    expect(stdout).toMatch(/Stock Splits:\n    Imported: 4\n    Skipped: 0\n    Errors: 1/);
    expect(stderr).toContain("Invalid split for sec-ccc on 20241001: Invalid split ratio: x:2");
  }, TIMEOUT);

  it("refuses bad arguments, a missing book and a bad file without writing", async () => {
    const refused = (args: string[], stderr: string) =>
      expect(rustImport(...args)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining(stderr) });
    const sample = fixturePath("moneydance-sample.json");
    await refused(["--book-id", "1"], "<path-to-json> is required");
    await refused([sample], "--book-id <id> is required");
    await refused([sample, "--book-id", "0"], "--book-id must be a positive integer");
    await refused([sample, "--book-id", "999"], "book 999 not found");
    await refused([fixturePath("missing.json"), "--book-id", "1"], "Failed to load file");
    await refused([path.resolve("package.json"), "--book-id", "1"], "Invalid export: missing metadata");
    expect(await count("accounts", 1)).toBe(0);
  }, TIMEOUT);

  it("exits 1 and keeps the book as it was when the lot rebuild fails", async () => {
    await createAccount({ name: "Before the import", type: "asset" });
    // The lot rebuild runs after every transaction, so it fails the run late.
    await script(`CREATE TRIGGER refuse_import_lot BEFORE INSERT ON investment_lots
      BEGIN SELECT RAISE(ABORT, 'refused for the test'); END;`);
    try {
      await expect(
        rustImport(fixturePath("moneydance-sample.json"), "--book-id", "1", "--overwrite")
      ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("Fatal error") });
    } finally {
      await script("DROP TRIGGER IF EXISTS refuse_import_lot");
    }
    expect(await count("transactions", 1)).toBe(0);
    expect(await count("accounts", 1)).toBe(1);
  }, TIMEOUT);
});
