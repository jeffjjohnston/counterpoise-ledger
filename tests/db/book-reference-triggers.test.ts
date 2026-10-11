import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  setupTestDatabase,
  resetTestDatabase,
  createBook,
  createAccount,
  createRecurringRule,
  createTransactionWithSplits,
} from "@/tests/helpers/db-utils";
import { exec, insert, scalar, type Row } from "@/tests/helpers/sql";

/**
 * Some references from one book row to another have a single-column foreign
 * key, so the key does not stop a row of another book. Migration 0006
 * (rust-api/db/migrations/0006_book_reference_checks.sql) adds a trigger on
 * insert and on update for each of them.
 *
 * Each case asserts both halves, as book-scoped-composite-fks.test.ts does: a
 * row in the same book is accepted, a row of another book is refused. The
 * writes go straight to the table, because the triggers are for a writer that
 * skips the check of its route.
 */
describe("book reference triggers", () => {
  type Ids = { mine: number; theirs: number };
  let ids: Record<"payee" | "rule" | "token" | "account" | "plaidAccount" | "transaction", Ids>;
  let userId: number;

  /** Two rows of `table`, one in book 1 and one in book 2. */
  async function pair(table: string, values: (bookId: number) => Row): Promise<Ids> {
    const mine = await insert<{ id: number }>(table, values(1));
    const theirs = await insert<{ id: number }>(table, values(2));
    return { mine: mine.id, theirs: theirs.id };
  }

  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    await createBook({ name: "Other Book" });
    userId = Number(await scalar("SELECT id FROM users ORDER BY id LIMIT 1"));

    const account = {
      mine: (await createAccount({ name: "My Bank", type: "asset", subtype: "bank", bookId: 1 })).id,
      theirs: (await createAccount({ name: "Their Bank", type: "asset", subtype: "bank", bookId: 2 })).id,
    };
    const rule = async (bookId: number, accountId: number) =>
      (await createRecurringRule({
        name: `Rule ${bookId}`,
        frequency: "monthly",
        startDate: "2026-01-01",
        nextDate: "2026-02-01",
        bookId,
        templateSplits: [{ accountId, amount: 0 }],
      })).id;
    const transaction = async (bookId: number, accountId: number) =>
      (await createTransactionWithSplits({ date: "2026-01-15", bookId, splits: [{ accountId, amount: 0 }] })).id;
    const token = await pair("plaid_tokens", (bookId) => ({
      bookId,
      financialInstitution: "Bank",
      itemId: `item-${bookId}`,
      accessToken: `access-${bookId}`,
    }));

    ids = {
      payee: await pair("payees", (bookId) => ({ bookId, name: `Payee ${bookId}` })),
      rule: { mine: await rule(1, account.mine), theirs: await rule(2, account.theirs) },
      token,
      account,
      plaidAccount: await pair("plaid_accounts", (bookId) => ({
        bookId,
        tokenId: bookId === 1 ? token.mine : token.theirs,
        plaidAccountId: `plaid-${bookId}`,
        name: "Checking",
        type: "depository",
      })),
      transaction: { mine: await transaction(1, account.mine), theirs: await transaction(2, account.theirs) },
    };
  });

  /**
   * One reference: the table and column, the referenced kind, and a valid
   * book-1 row of the table without the column.
   */
  interface Reference {
    table: string;
    column: string;
    kind: keyof typeof ids;
    nullable: boolean;
    row: () => Row;
  }

  const references: Reference[] = [
    {
      table: "transactions", column: "payee_id", kind: "payee", nullable: true,
      row: () => ({ bookId: 1, date: "2026-03-01" }),
    },
    {
      table: "transactions", column: "recurring_rule_id", kind: "rule", nullable: true,
      row: () => ({ bookId: 1, date: "2026-03-01" }),
    },
    {
      table: "recurring_rules", column: "payee_id", kind: "payee", nullable: true,
      row: () => ({ bookId: 1, name: "Rent", frequency: "monthly", startDate: "2026-01-01", nextDate: "2026-02-01" }),
    },
    {
      table: "plaid_accounts", column: "token_id", kind: "token", nullable: false,
      row: () => ({ bookId: 1, plaidAccountId: `plaid-new-${Math.random()}`, name: "Savings", type: "depository" }),
    },
    {
      table: "plaid_accounts", column: "counterpoise_account_id", kind: "account", nullable: true,
      row: () => ({
        bookId: 1, tokenId: ids.token.mine, plaidAccountId: `plaid-new-${Math.random()}`, name: "Savings", type: "depository",
      }),
    },
    {
      table: "plaid_transaction_reconciliation", column: "plaid_account_link_id", kind: "plaidAccount", nullable: false,
      row: () => ({
        bookId: 1, plaidTransactionId: `txn-${Math.random()}`, date: "2026-03-01", amountCents: 100, name: "Coffee", rawJson: "{}",
      }),
    },
    {
      table: "plaid_transaction_reconciliation", column: "matched_transaction_id", kind: "transaction", nullable: true,
      row: () => ({
        bookId: 1, plaidAccountLinkId: ids.plaidAccount.mine, plaidTransactionId: `txn-${Math.random()}`,
        date: "2026-03-01", amountCents: 100, name: "Coffee", rawJson: "{}",
      }),
    },
    ...(["token_id", "result_token_id"] as const).map((column): Reference => ({
      table: "plaid_link_sessions", column, kind: "token", nullable: true,
      row: () => {
        const now = new Date();
        return {
          bookId: 1, userId, linkToken: "link-token", hostedLinkUrl: "https://example.test/link", status: "pending",
          expiresAt: now, createdAt: now, updatedAt: now,
        };
      },
    })),
  ];

  const crossBook = /cross-book reference/;

  describe.each(references.map((reference) => ({ ...reference, name: `${reference.table}.${reference.column}` })))("$name", (reference) => {
    const withRef = (value: number | null): Row => ({ ...reference.row(), [reference.column]: value });

    it("accepts a row of the same book and refuses a row of another book on insert", async () => {
      await expect(insert(reference.table, withRef(ids[reference.kind].mine))).resolves.toBeDefined();
      await expect(insert(reference.table, withRef(ids[reference.kind].theirs)))
        .rejects.toThrow(crossBook);
    });

    it("refuses an update to a row of another book", async () => {
      const { id } = await insert<{ id: number }>(reference.table, withRef(ids[reference.kind].mine));
      await expect(
        exec(`UPDATE ${reference.table} SET ${reference.column} = $1 WHERE id = $2`, [ids[reference.kind].theirs, id])
      ).rejects.toThrow(crossBook);
      // An update that keeps the row and its reference in one book passes.
      await expect(exec(`UPDATE ${reference.table} SET book_id = book_id WHERE id = $1`, [id])).resolves.toBe(1);
    });

    if (reference.nullable) {
      it("accepts a null reference", async () => {
        await expect(insert(reference.table, withRef(null))).resolves.toBeDefined();
      });
    }
  });

  /** A change of book_id alone also moves the row away from what it references. */
  it("refuses an update of book_id that leaves a reference in the old book", async () => {
    const { id } = await insert<{ id: number }>("transactions", {
      bookId: 1, date: "2026-03-01", payeeId: ids.payee.mine,
    });
    await expect(exec("UPDATE transactions SET book_id = 2 WHERE id = $1", [id])).rejects.toThrow(crossBook);
  });
});
