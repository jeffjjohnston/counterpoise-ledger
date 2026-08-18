import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { buildSeedData } from "./seed-data";

const formatCurrency = (cents: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);

const getAccountAmount = (
  page: Page,
  cardTitle: "Income" | "Expenses",
  accountName: string
) => {
  const card = page
    .getByRole("heading", { level: 3, name: cardTitle })
    .locator("..")
    .locator("..");
  const row = card.getByRole("link", { name: accountName }).locator("..");
  return row.locator("span").last();
};

test("updates income statement amounts by period", async ({ page }) => {
  const seed = buildSeedData();

  await page.goto("/b/1/reports/income-statement");
  await expect(
    page.getByRole("heading", { name: "Income Statement" })
  ).toBeVisible();

  const salaryAmount = getAccountAmount(page, "Income", "Salary");
  const groceriesAmount = getAccountAmount(page, "Expenses", "Groceries");

  await page.locator("#incomePeriod").selectOption("current_month");
  await expect(salaryAmount).toHaveText(
    formatCurrency(seed.totals.currentMonthIncome)
  );
  await expect(groceriesAmount).toHaveText(
    formatCurrency(seed.totals.currentMonthExpense)
  );

  await page.locator("#incomePeriod").selectOption("last_year");
  await expect(salaryAmount).toHaveText(
    formatCurrency(seed.totals.lastYearIncome)
  );
  await expect(groceriesAmount).toHaveText(
    formatCurrency(seed.totals.lastYearExpense)
  );

  await page.locator("#incomePeriod").selectOption("custom");
  await page.getByLabel("Start date").fill(seed.dates.lastYearStart);
  await page.getByLabel("End date").fill(seed.dates.lastYearEnd);
  await expect(salaryAmount).toHaveText(
    formatCurrency(seed.totals.lastYearIncome)
  );
});
