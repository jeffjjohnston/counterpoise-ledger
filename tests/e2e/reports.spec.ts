import { test, expect } from "@playwright/test";

test.describe("reports", () => {
  test("displays reports page with configuration panel", async ({ page }) => {
    await page.goto("/b/1/reports");
    await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible();

    // Config controls should be visible
    await expect(page.getByRole("button", { name: "YTD" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Generate Report" })
    ).toBeVisible();

    // Account type toggles
    await expect(page.getByRole("button", { name: "Income" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Expenses" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Assets" })).toBeVisible();
  });

  test("auto-generates YTD income/expense report on load", async ({
    page,
  }) => {
    // Default config selects Income + Expenses with YTD date range, grouped by month, and auto-runs
    await page.goto("/b/1/reports");

    // Wait for the report table to appear with the Total footer row
    await expect(page.getByText("Total")).toBeVisible({ timeout: 10000 });

    // Expand All to reveal individual account names within month groups
    await page.getByRole("button", { name: "Expand All" }).click();

    // Seed data has Salary (income) and Groceries (expense) accounts
    await expect(page.getByText("Salary").first()).toBeVisible();
    await expect(page.getByText("Groceries").first()).toBeVisible();
  });

  test("generates report after toggling account types", async ({ page }) => {
    await page.goto("/b/1/reports");

    // Wait for auto-generated report
    await expect(page.getByText("Total")).toBeVisible({ timeout: 10000 });

    // Deselect Expenses (Income + Expenses are selected by default)
    await page.getByRole("button", { name: "Expenses" }).click();

    // Regenerate with only Income selected
    await page.getByRole("button", { name: "Generate Report" }).click();

    // Wait for report to reload
    await expect(page.getByText("Total")).toBeVisible({ timeout: 10000 });

    // Expand to see account-level detail
    await page.getByRole("button", { name: "Expand All" }).click();

    // Salary (income) should be visible
    await expect(page.getByText("Salary").first()).toBeVisible();

    // Groceries (expense) should no longer appear since we deselected Expenses
    await expect(page.getByText("Groceries")).not.toBeVisible();
  });

  test("changes date range to Last Year", async ({ page }) => {
    await page.goto("/b/1/reports");

    // Wait for auto-run to finish
    await expect(page.getByText("Total")).toBeVisible({ timeout: 10000 });

    // Select Last Year preset
    await page.getByRole("button", { name: "Last Year" }).click();

    // Generate the report
    await page.getByRole("button", { name: "Generate Report" }).click();

    // Should show report with data (seed data covers 2023-2025)
    await expect(page.getByText("Total")).toBeVisible({ timeout: 10000 });

    // Expand to check for account data
    await page.getByRole("button", { name: "Expand All" }).click();

    // Last year's income data should include Salary
    await expect(page.getByText("Salary").first()).toBeVisible();
  });
});
