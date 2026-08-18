import { test, expect } from "@playwright/test";

// Get today's date in MM/DD/YYYY format for the DateInput component
const today = new Date();
const todayMDY = `${String(today.getMonth() + 1).padStart(2, "0")}/${String(today.getDate()).padStart(2, "0")}/${today.getFullYear()}`;
const todayYMD = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

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
    groceriesId: flattened.find((account) => account.name === "Groceries")?.id,
  };
}

async function createSimpleTransaction(
  page: import("@playwright/test").Page,
  payeeName: string,
  amountCents: number
) {
  const { checkingId, groceriesId } = await getAccountIds(page);
  expect(checkingId).toBeTruthy();
  expect(groceriesId).toBeTruthy();

  const response = await page.request.post("/api/b/1/transactions", {
    data: {
      date: todayYMD,
      description: `${payeeName} description`,
      payeeName,
      splits: [
        { accountId: groceriesId, amount: amountCents },
        { accountId: checkingId, amount: -amountCents },
      ],
    },
  });

  expect(response.ok()).toBeTruthy();
  return response.json();
}

test.describe("transaction CRUD", () => {
  test("creates a simple transaction", async ({ page }) => {
    await page.goto("/b/1/transactions");

    // Wait for transactions page to load
    await expect(
      page.getByRole("heading", { name: "All Transactions" })
    ).toBeVisible();

    // Wait for table rows to appear
    await expect(page.locator("tbody tr").first()).toBeVisible();

    // Date input uses MM/DD/YYYY text format — use today's date so it appears at top
    const dateInput = page.locator("#date");
    await dateInput.click();
    await dateInput.fill(todayMDY);
    // Click elsewhere to close any calendar popup
    await page.getByRole("heading", { name: "All Transactions" }).click();

    // Payee - use exact placeholder match (there's also a "Filter by payee..." input)
    await page.getByPlaceholder("Payee", { exact: true }).fill("New Store");

    // From Account - click to focus (opens dropdown), type to filter, click matching button
    const fromInput = page.getByPlaceholder("From...");
    await fromInput.click();
    await fromInput.fill("Checking");
    // The dropdown items are <button> elements; find one with "Checking" text inside the autocomplete dropdown
    await page.locator("button").filter({ hasText: /^Checking$/ }).first().click();

    // To Account
    const toInput = page.getByPlaceholder("To...");
    await toInput.click();
    await toInput.fill("Groceries");
    await page.locator("button").filter({ hasText: /^Groceries$/ }).first().click();

    // Amount
    await page.getByLabel("Amount").fill("42.50");

    // Submit
    await page.getByRole("button", { name: "Add Transaction" }).click();

    // Wait for the transaction to appear — the page refreshes data after create
    // Look for $42.50 amount which is unique in the dataset
    await expect(page.locator("tbody tr").filter({ hasText: "$42.50" }).first()).toBeVisible({ timeout: 10000 });
  });

  test("edits an existing transaction", async ({ page }) => {
    const payeeName = uniqueName("Whole Foods");
    await createSimpleTransaction(page, payeeName, 5150);

    await page.goto("/b/1/transactions");

    // Wait for transactions page to load
    await expect(
      page.getByRole("heading", { name: "All Transactions" })
    ).toBeVisible();

    // Wait for transaction list to load
    await expect(page.locator("tbody tr").first()).toBeVisible();

    await page.locator("tbody tr").filter({ hasText: payeeName }).first().click();

    // The edit modal should appear
    await expect(page.getByRole("heading", { name: "Edit Transaction", level: 2 })).toBeVisible();

    // Change the description
    await page.getByLabel("Description").fill("Updated grocery trip");

    await page.getByRole("button", { name: "Save Changes" }).click();

    // Wait for edit modal to close
    await expect(page.getByRole("heading", { name: "Edit Transaction", level: 2 })).not.toBeVisible();

    await expect(page.locator("tbody tr").filter({ hasText: payeeName }).first()).toBeVisible();
  });

  test("deletes a transaction", async ({ page }) => {
    const payeeName = uniqueName("Delete Target");
    await createSimpleTransaction(page, payeeName, 4250);

    await page.goto("/b/1/transactions");

    // Wait for transactions page to load
    await expect(
      page.getByRole("heading", { name: "All Transactions" })
    ).toBeVisible();

    // Wait for transaction list to load
    await expect(page.locator("tbody tr").first()).toBeVisible();

    await page.locator("tbody tr").filter({ hasText: payeeName }).first().click();
    await expect(page.getByRole("heading", { name: "Edit Transaction", level: 2 })).toBeVisible();

    page.on("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Delete" }).click();

    await expect(page.locator("tbody tr").filter({ hasText: payeeName })).toHaveCount(0, {
      timeout: 10000,
    });
  });
});
