import { test, expect } from "@playwright/test";

test.describe("dashboard", () => {
  test("displays summary cards with balances", async ({ page }) => {
    await page.goto("/b/1");
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

    // Three summary cards
    await expect(page.getByText("Assets").first()).toBeVisible();
    await expect(page.getByText("Liabilities").first()).toBeVisible();
    await expect(page.getByText("Net Worth").first()).toBeVisible();
  });

  test("displays account groups", async ({ page }) => {
    await page.goto("/b/1");
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

    // Asset accounts from seed data — use exact link match to avoid strict mode violation
    await expect(page.getByRole("link", { name: "Checking", exact: true }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Savings", exact: true }).first()).toBeVisible();
  });

  test("displays recent transactions", async ({ page }) => {
    await page.goto("/b/1");

    await expect(page.getByText("Recent Transactions")).toBeVisible();
    await expect(page.getByText("View All")).toBeVisible();

    // Seed data has transactions, so at least one should appear
    const transactionLinks = page.locator("a").filter({ hasText: /\$/ });
    await expect(transactionLinks.first()).toBeVisible();
  });

  test("View All link navigates to transactions page", async ({ page }) => {
    await page.goto("/b/1");
    await page.getByText("View All").click();
    await expect(page).toHaveURL(/\/b\/1\/transactions/);
  });
});
