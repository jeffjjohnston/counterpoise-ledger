import { test, expect } from "@playwright/test";

test("paginates transactions for a selected account", async ({ page }) => {
  await page.goto("/b/1/transactions");

  await page.getByRole("link", { name: "Checking" }).first().click();
  await expect(page.getByRole("columnheader", { name: "Balance" })).toBeVisible();

  const rows = page.locator("tbody tr");
  await expect(rows).toHaveCount(50);

  // Scroll to bottom to trigger infinite scroll loading
  const scrollForMore = page.getByText("Scroll for more");
  await expect(scrollForMore).toBeVisible();
  await scrollForMore.scrollIntoViewIfNeeded();

  // After scrolling, more rows should load beyond the initial page of 50.
  // We don't assert an exact count because other e2e tests running in
  // parallel may create transactions that touch this account.
  await expect(async () => {
    const count = await rows.count();
    expect(count).toBeGreaterThan(50);
  }).toPass({ timeout: 10000 });
});
