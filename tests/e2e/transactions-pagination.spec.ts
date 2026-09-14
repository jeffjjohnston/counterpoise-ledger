import { buildSeedData } from "./seed-data";
import { test, expect } from "./fixtures";

test("paginates transactions for a selected account", async ({ page, bookId }) => {
  await page.goto(`/b/${bookId}/transactions`);

  await page.getByRole("link", { name: "Checking" }).first().click();
  await expect(page.getByRole("columnheader", { name: "Balance" })).toBeVisible();

  const rows = page.locator("tbody tr");
  await expect(rows).toHaveCount(50);

  // Scroll to bottom to trigger infinite scroll loading
  const scrollForMore = page.getByText("Scroll for more");
  await expect(scrollForMore).toBeVisible();
  await scrollForMore.scrollIntoViewIfNeeded();

  await expect(rows).toHaveCount(buildSeedData().checkingTransactionCount);
  await expect(scrollForMore).not.toBeVisible();
});
