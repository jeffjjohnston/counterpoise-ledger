import { beforeAll, expect, it } from "vitest";
import { accounts, books, transactions } from "@/db/schema";
import {
  createAccount,
  createBook,
  createTransactionWithSplits,
  db,
  resetTestDatabase,
  setupTestDatabase,
} from "@/tests/helpers/db-utils";

beforeAll(setupTestDatabase);

it("clears dependent rows and resets sequences while keeping the baseline book", async () => {
  await resetTestDatabase();
  const checking = await createAccount({ name: "Checking", type: "asset" });
  const income = await createAccount({ name: "Income", type: "income" });
  await createTransactionWithSplits({
    date: "2026-09-24",
    splits: [
      { accountId: checking.id, amount: 100 },
      { accountId: income.id, amount: -100 },
    ],
  });
  await createBook({ name: "Extra" });

  await resetTestDatabase();

  expect(await db.select().from(accounts)).toHaveLength(0);
  expect(await db.select().from(transactions)).toHaveLength(0);
  expect(await db.select().from(books)).toMatchObject([{ id: 1, name: "Test Book" }]);
  expect((await createAccount({ name: "Checking", type: "asset" })).id).toBe(1);
  expect((await createBook({ name: "Extra" })).id).toBe(2);
});
