import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createAccount,
  createBook,
  createTransactionWithSplits,
  db,
  resetTestDatabase,
  setupTestDatabase,
} from "../helpers/db-utils";
import { workerDatabaseUrl } from "../helpers/database-safety";
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
      DATABASE_URL: workerDatabaseUrl(),
      TZ: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  });
}

async function count(table: string, bookId: number) {
  const [row] = await db.execute<{ count: number }>(
    sql.raw(`select cast(count(*) as integer) as count from "${table}" where book_id = ${bookId}`)
  );
  return row.count;
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
    const names = (await db.execute<{ name: string }>(sql`select name from accounts order by id`)).map((row) => row.name);
    expect(names).toEqual(expect.arrayContaining(["Auto:Fuel", "Legacy:Dues", "Brokerage - Cash", "Imported Balance"]));
    expect(names).not.toContain("Unknown Type");
    const payees = (await db.execute<{ name: string }>(sql`select name from payees order by id`)).map((row) => row.name);
    expect(payees).toEqual(expect.arrayContaining(["Employer's Payroll", "City Garage", "Bad Date Store"]));
    // Two security accounts hold AAA, so it is one security.
    const symbols = (await db.execute<{ symbol: string }>(sql`select symbol from securities order by id`)).map((row) => row.symbol);
    expect(symbols).toEqual(["AAA", "BBB", "Gamma Growth", "DDD"]);
    const reinvested = await db.execute(sql`select 1 from transactions where description in ('AAA Dividend (Dividend)', 'AAA Dividend (Reinvestment)')`);
    expect(reinvested).toHaveLength(2);
    const ratios = await db.execute<{ n: number; d: number }>(
      sql`select split_numerator as n, split_denominator as d from investment_splits where action = 'split' order by id`
    );
    expect([...ratios]).toEqual([{ n: 2, d: 1 }, { n: 2, d: 1 }, { n: 1, d: 2 }]);
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
    const before = await db.execute(sql`select * from transaction_splits where book_id = ${other.id} order by id`);

    await rustImport(fixturePath("moneydance-sample.json"), "--book-id", "1");

    const offsets = await db.execute<{ book_id: number }>(sql`
      select a.book_id from transaction_splits s join accounts a on a.id = s.account_id
      where a.name = 'Imported Balance' and s.book_id = 1`);
    expect(offsets.length).toBeGreaterThan(0);
    expect(offsets.every((row) => row.book_id === 1)).toBe(true);
    expect(await db.execute(sql`select * from transaction_splits where book_id = ${other.id} order by id`)).toEqual(before);
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
    await db.execute(sql.raw(`
      create function refuse_import_lot() returns trigger language plpgsql as $$
      begin raise exception 'refused for the test'; end $$;
      create trigger refuse_import_lot before insert on investment_lots
        for each row execute function refuse_import_lot();`));
    try {
      await expect(
        rustImport(fixturePath("moneydance-sample.json"), "--book-id", "1", "--overwrite")
      ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("Fatal error") });
    } finally {
      await db.execute(sql.raw(`
        drop trigger refuse_import_lot on investment_lots;
        drop function refuse_import_lot();`));
    }
    expect(await count("transactions", 1)).toBe(0);
    expect(await count("accounts", 1)).toBe(1);
  }, TIMEOUT);
});
