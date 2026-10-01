import { beforeAll, expect, it } from "vitest";
import {
  createAccount,
  createBook,
  createTransactionWithSplits,
  resetTestDatabase,
  setupTestDatabase,
} from "@/tests/helpers/db-utils";
import { count, rows } from "@/tests/helpers/sql";

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

  expect(await count("accounts")).toBe(0);
  expect(await count("transactions")).toBe(0);
  expect(await count("transaction_splits")).toBe(0);
  expect(await rows("SELECT id, name FROM books")).toEqual([{ id: 1, name: "Test Book" }]);
  expect((await createAccount({ name: "Checking", type: "asset" })).id).toBe(1);
  expect((await createBook({ name: "Extra" })).id).toBe(2);
});
