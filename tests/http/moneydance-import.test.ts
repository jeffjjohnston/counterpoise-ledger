import { execFile } from "node:child_process";
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
    const reinvested = await rows(
      "SELECT id FROM transactions WHERE description IN ($1, $2)",
      ["AAA Dividend (Dividend)", "AAA Dividend (Reinvestment)"],
    );
    expect(reinvested).toHaveLength(2);
    const ratios = await rows<{ n: number; d: number }>(
      "SELECT split_numerator AS n, split_denominator AS d FROM investment_splits WHERE action = $1 ORDER BY id", ["split"]
    );
    expect(ratios).toEqual([{ n: 2, d: 1 }, { n: 2, d: 1 }, { n: 1, d: 2 }]);
    // Every reminder with a known frequency and imported accounts, and no bad date.
    expect(await count("recurring_rules", 1)).toBe(5);
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
