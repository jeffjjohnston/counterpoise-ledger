import { test, expect } from "@playwright/test";
import { toDateString } from "../../lib/formatters";

// Rules must be dated in the same timezone the app reckons "today" in. Using
// toISOString() here dates them in UTC, which after ~8pm ET creates a rule due
// tomorrow — never due, never processed. The suite then passed or failed
// depending on the hour it ran.
function today() {
  return toDateString(new Date());
}

function uniqueName(prefix: string) {
  return `${prefix} ${Date.now()}-${Math.round(Math.random() * 1000)}`;
}

async function getAccountIds(page: import("@playwright/test").Page) {
  const response = await page.request.get("/api/b/1/accounts?includeInactive=true");
  expect(response.ok()).toBeTruthy();
  const data = await response.json();
  const flattened: Array<{ id: number; name: string }> = [];

  const visit = (accounts: Array<{ id: number; name: string; children?: unknown[] }>) => {
    for (const account of accounts) {
      flattened.push({ id: account.id, name: account.name });
      if (Array.isArray(account.children)) {
        visit(account.children as Array<{ id: number; name: string; children?: unknown[] }>);
      }
    }
  };

  visit(data);

  return {
    checkingId: flattened.find((account) => account.name === "Checking")?.id,
    rentId: flattened.find((account) => account.name === "Rent")?.id,
  };
}

async function createRecurringRule(
  page: import("@playwright/test").Page,
  name: string
) {
  const { checkingId, rentId } = await getAccountIds(page);
  expect(checkingId).toBeTruthy();
  expect(rentId).toBeTruthy();

  const response = await page.request.post("/api/b/1/recurring", {
    data: {
      name,
      frequency: "daily",
      interval: 1,
      startDate: today(),
      templateDescription: `${name} description`,
      templateSplits: [
        { accountId: rentId, amount: 150000 },
        { accountId: checkingId, amount: -150000 },
      ],
    },
  });

  expect(response.ok()).toBeTruthy();
  return response.json();
}

test.describe("recurring transactions", () => {
  test("displays recurring rules list", async ({ page }) => {
    await page.goto("/b/1/recurring");
    await expect(
      page.getByRole("heading", { name: "Recurring Transactions" })
    ).toBeVisible();

    // Seed recurring rule — use heading role to avoid matching calendar occurrence
    await expect(page.getByRole("heading", { name: "Monthly Rent" })).toBeVisible();
  });

  test("displays the upcoming calendar", async ({ page }) => {
    await page.goto("/b/1/recurring");
    await expect(
      page.getByRole("heading", { name: /Upcoming Calendar/ })
    ).toBeVisible();
    await expect(page.getByTestId("recurring-calendar")).toBeVisible();
  });

  test("edits an existing recurring rule", async ({ page }) => {
    const originalName = uniqueName("Recurring Edit");
    const updatedName = uniqueName("Recurring Edit Updated");
    const rule = await createRecurringRule(page, originalName);

    await page.goto("/b/1/recurring");

    const ruleCard = page.getByTestId(`recurring-rule-card-${rule.id}`);
    await expect(ruleCard).toBeVisible();
    await ruleCard.getByRole("button", { name: "Edit" }).click();
    await expect(page.getByText("Edit Recurring Transaction")).toBeVisible();

    await page.getByLabel("Rule Name").clear();
    await page.getByLabel("Rule Name").fill(updatedName);
    await page.getByRole("button", { name: "Save Changes" }).click();

    await expect(
      page.getByTestId(`recurring-rule-card-${rule.id}`).getByRole("heading", {
        name: updatedName,
      })
    ).toBeVisible();
  });

  test("pauses and resumes a recurring rule", async ({ page }) => {
    await page.goto("/b/1/recurring");

    // Pause the rule
    await page.getByRole("button", { name: "Pause" }).first().click();
    await expect(page.getByRole("button", { name: "Resume" }).first()).toBeVisible();

    // Resume the rule
    await page.getByRole("button", { name: "Resume" }).first().click();
    await expect(page.getByRole("button", { name: "Pause" }).first()).toBeVisible();
  });

  test("creates a new recurring rule via UI", async ({ page }) => {
    const ruleName = uniqueName("Weekly Groceries");

    await page.goto("/b/1/recurring");
    await expect(
      page.getByRole("heading", { name: "Recurring Transactions" })
    ).toBeVisible();

    await page.getByRole("button", { name: "New Rule" }).click();
    await expect(page.getByText("New Recurring Transaction")).toBeVisible();

    // Fill in rule name
    await page.getByLabel("Rule Name").fill(ruleName);

    // Select weekly frequency
    await page.getByLabel("Frequency").selectOption("weekly");

    // Fill in account autocomplete fields
    const accountInputs = page.getByPlaceholder("Search for account...");
    await expect(accountInputs.first()).toBeVisible();

    // First split: Groceries expense account (debit)
    await accountInputs.nth(0).click();
    await accountInputs.nth(0).fill("Groceries");
    // Click the first matching account in the autocomplete dropdown
    const dropdown0 = page.locator(".absolute.z-50").filter({ hasText: "Groceries" }).first();
    await dropdown0.getByRole("button").filter({ hasText: /Groceries/ }).first().click();

    // Second split: Checking account (credit)
    await accountInputs.nth(1).click();
    await accountInputs.nth(1).fill("Checking");
    const dropdown1 = page.locator(".absolute.z-50").filter({ hasText: "Checking" }).first();
    await dropdown1.getByRole("button").filter({ hasText: /Checking/ }).first().click();

    // Fill amounts: debit 150 on first row, credit 150 on second row
    const amountInputs = page.getByPlaceholder("0.00");
    // Row 0 debit = index 0, row 0 credit = index 1, row 1 debit = index 2, row 1 credit = index 3
    await amountInputs.nth(0).fill("150.00");
    await amountInputs.nth(0).blur();
    await amountInputs.nth(3).fill("150.00");
    await amountInputs.nth(3).blur();

    await page.getByRole("button", { name: "Create Rule" }).click();

    // Modal should close and rule should appear in the list
    await expect(page.getByText("New Recurring Transaction")).not.toBeVisible();
    await expect(page.getByRole("heading", { name: ruleName })).toBeVisible();
  });

  test("deletes a recurring rule", async ({ page }) => {
    const ruleName = uniqueName("Recurring Delete");
    const rule = await createRecurringRule(page, ruleName);

    await page.goto("/b/1/recurring");

    page.on("dialog", (dialog) => dialog.accept());
    const ruleCard = page.getByTestId(`recurring-rule-card-${rule.id}`);
    await expect(ruleCard).toBeVisible();
    await ruleCard.getByRole("button", { name: "Delete" }).click();

    await expect(page.getByTestId(`recurring-rule-card-${rule.id}`)).toHaveCount(0);
  });

  test("processes a due recurring rule and creates a transaction", async ({ page }) => {
    const { checkingId, rentId } = await getAccountIds(page);
    expect(checkingId).toBeTruthy();
    expect(rentId).toBeTruthy();

    // Create a rule with nextDate = today (already due)
    const ruleName = uniqueName("Due Rule");
    const response = await page.request.post("/api/b/1/recurring", {
      data: {
        name: ruleName,
        frequency: "monthly",
        interval: 1,
        startDate: today(),
        templateDescription: `${ruleName} payment`,
        templateSplits: [
          { accountId: rentId, amount: 50000 },
          { accountId: checkingId, amount: -50000 },
        ],
      },
    });
    expect(response.ok()).toBeTruthy();

    await page.goto("/b/1/recurring");
    await expect(page.getByRole("heading", { name: ruleName })).toBeVisible();

    // The "Process All Due" button should be visible since our rule is due today
    const processButton = page.getByRole("button", { name: /Process All Due/ });
    await expect(processButton).toBeVisible({ timeout: 5000 });

    await processButton.click();

    // Wait a moment for processing to complete
    await page.waitForTimeout(1000);

    // After processing, verify a transaction was created via the API
    const transactionsResponse = await page.request.get("/api/b/1/transactions?limit=20");
    expect(transactionsResponse.ok()).toBeTruthy();
    const transactionsData = await transactionsResponse.json();
    const allTransactions = Array.isArray(transactionsData) ? transactionsData : (transactionsData.transactions ?? []);
    const createdTransaction = allTransactions.find(
      (t: { description?: string }) => t.description === `${ruleName} payment`
    );
    expect(createdTransaction).toBeTruthy();
  });
});
