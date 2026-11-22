import { buildSeedData } from "./seed-data";
import { test, expect } from "./fixtures";

test("paginates transactions for a selected account", async ({ page, bookId }) => {
  await page.goto(`/b/${bookId}/transactions`);

  await page.getByRole("link", { name: "Checking" }).first().click();
  await expect(page.getByRole("table", { name: "Transactions" }).getByRole("columnheader", { name: "Balance" })).toBeVisible();

  // The year attribute selects the transaction rows only, not the year dividers.
  const rows = page.getByRole("table", { name: "Transactions" }).locator("tbody tr[data-effective-year]");
  await expect(rows).toHaveCount(50);

  // Scroll to bottom to trigger infinite scroll loading
  const scrollForMore = page.getByText("Scroll for more");
  await expect(scrollForMore).toBeVisible();
  await scrollForMore.scrollIntoViewIfNeeded();

  await expect(rows).toHaveCount(buildSeedData().checkingTransactionCount);
  await expect(scrollForMore).not.toBeVisible();
});
