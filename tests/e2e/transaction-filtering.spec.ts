import { test, expect } from "@playwright/test";
import { buildSeedData } from "./seed-data";

test.describe("transaction filtering", () => {
  test("filters transactions by date range", async ({ page }) => {
    const seed = buildSeedData();

    await page.goto("/b/1/transactions");
    await expect(page.getByRole("heading", { name: "All Transactions" })).toBeVisible();
    await expect(page.locator("tbody tr").first()).toBeVisible();

    // Verify all transactions are present (transfers + a few named ones)
    const initialCount = await page.locator("tbody tr").count();
    expect(initialCount).toBeGreaterThan(10);

    // Set date range to last year only
    const startInput = page.getByPlaceholder("Start date");
    const endInput = page.getByPlaceholder("End date");

    await startInput.fill(seed.dates.lastYearStart);
    await endInput.fill(seed.dates.lastYearEnd);

    // Wait for filtered results — only last-year transactions should remain
    // Last year has 3 transactions: Salary (Acme Corp), Groceries (Whole Foods), Buy VTI
    await expect(async () => {
      const count = await page.locator("tbody tr").count();
      expect(count).toBeLessThan(10);
    }).toPass({ timeout: 10000 });

    // Verify last-year transactions are visible (by payee or account names)
    await expect(page.getByText("Acme Corp").first()).toBeVisible();
    await expect(page.getByText("Whole Foods").first()).toBeVisible();

    // Current month and last month transfers should not be visible
    // Check that current-month date string is absent from table rows
    const currentMonthFormatted = new Date(seed.dates.currentMonth).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    await expect(page.locator("tbody").getByText(currentMonthFormatted)).not.toBeVisible();
  });

  test("filters transactions by payee", async ({ page }) => {
    await page.goto("/b/1/transactions");
    await expect(page.getByRole("heading", { name: "All Transactions" })).toBeVisible();
    await expect(page.locator("tbody tr").first()).toBeVisible();

    // Use the payee filter
    const payeeFilter = page.getByPlaceholder("Filter by payee...");
    await payeeFilter.click();
    await payeeFilter.fill("Whole Foods");

    // Select from dropdown
    await page.locator("button").filter({ hasText: /^Whole Foods$/ }).first().click();

    // Wait for filtered results — only Whole Foods transactions visible
    await expect(async () => {
      const count = await page.locator("tbody tr").count();
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThan(10);
    }).toPass({ timeout: 10000 });

    // Whole Foods rows should appear
    await expect(page.locator("tbody tr").filter({ hasText: "Whole Foods" }).first()).toBeVisible();

    // Acme Corp (salary) rows should not appear
    await expect(page.locator("tbody tr").filter({ hasText: "Acme Corp" })).toHaveCount(0);
  });

  test("clears date filter restores all transactions", async ({ page }) => {
    const seed = buildSeedData();

    await page.goto("/b/1/transactions");
    await expect(page.getByRole("heading", { name: "All Transactions" })).toBeVisible();
    await expect(page.locator("tbody tr").first()).toBeVisible();

    // Apply a restrictive date range (only last year)
    await page.getByPlaceholder("Start date").fill(seed.dates.lastYearStart);
    await page.getByPlaceholder("End date").fill(seed.dates.lastYearEnd);

    // Wait for filter to apply — should have fewer rows
    await expect(async () => {
      const count = await page.locator("tbody tr").count();
      expect(count).toBeLessThan(10);
    }).toPass({ timeout: 10000 });

    // Clear the date range using the Clear button
    await page.getByRole("button", { name: "Clear" }).click();

    // All transactions should reappear (transfers + named ones)
    await expect(async () => {
      const count = await page.locator("tbody tr").count();
      expect(count).toBeGreaterThan(10);
    }).toPass({ timeout: 10000 });
  });
});
