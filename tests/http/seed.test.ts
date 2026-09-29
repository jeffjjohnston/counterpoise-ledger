import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { verifyPassword } from "../helpers/password";
import { createAccount, createBook, db, resetTestDatabase, setupTestDatabase } from "../helpers/db-utils";
import { workerDatabaseUrl } from "../helpers/database-safety";
import { dumpTables as dump } from "../helpers/table-dump";

const run = promisify(execFile);
const CLI = path.resolve("rust-api/target/debug/ledger-cli");
const SEED_TIMEOUT = 180_000;

/** Run the Rust seed against this worker's database, in this process's zone. */
async function rustSeed(...args: string[]) {
  return run(CLI, ["seed", ...args], {
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

// The TypeScript seed was the reference for `ledger-cli seed` until the
// TypeScript server was retired; this suite held both to the same rows. The
// seed writes dates relative to today, so a recorded dump would change every
// day. The suite checks the counts, the balance and the determinism instead.
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
    const [{ unbalanced }] = await db.execute<{ unbalanced: number }>(sql`
      select cast(count(*) as integer) as unbalanced from (
        select transaction_id from transaction_splits group by transaction_id having sum(amount) <> 0
      ) t`);
    expect(unbalanced).toBe(0);

    await resetTestDatabase();
    await rustSeed("--book-id", "1");
    expect(await dump()).toEqual(first);
  }, SEED_TIMEOUT);

  it("creates the admin user and the Family Finances book without --book-id", async () => {
    const { stdout } = await rustSeed();
    const [book] = await db.execute<{ id: number }>(sql`select id from books where name = 'Family Finances'`);
    expect(stdout).toContain(
      `Created user 'admin' (password: 'password') and book 'Family Finances' (id: ${book.id})`
    );
    expect(await count("transactions", book.id)).toBe(2235);

    const [admin] = await db.execute<{ password_hash: string }>(
      sql`select password_hash from users where username = 'admin'`
    );
    expect(await verifyPassword("password", admin.password_hash)).toBe(true);
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
  });

  it("exits 1 and keeps the book as it was when a late step fails", async () => {
    await createAccount({ name: "Before the seed", type: "asset" });
    // The Plaid rows come after every transaction, so this trigger fails the
    // seed late in the run.
    await db.execute(sql.raw(`
      create function refuse_seed_token() returns trigger language plpgsql as $$
      begin raise exception 'refused for the test'; end $$;
      create trigger refuse_seed_token before insert on plaid_tokens
        for each row execute function refuse_seed_token();`));
    try {
      await expect(rustSeed("--book-id", "1")).rejects.toMatchObject({
        code: 1, stderr: expect.stringContaining("Seed failed"),
      });
    } finally {
      await db.execute(sql.raw(`
        drop trigger refuse_seed_token on plaid_tokens;
        drop function refuse_seed_token();`));
    }
    expect(await count("transactions", 1)).toBe(0);
    expect(await count("accounts", 1)).toBe(1);
  }, SEED_TIMEOUT);
});
