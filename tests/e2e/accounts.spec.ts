import { test, expect } from "@playwright/test";

function accountRow(page: import("@playwright/test").Page, name: string) {
  return page
    .getByTestId("account-row")
    .filter({ has: page.getByRole("link", { name, exact: true }) });
}

function uniqueName(prefix: string) {
  return `${prefix} ${Date.now()}-${Math.round(Math.random() * 1000)}`;
}

async function createLiabilityAccount(
  page: import("@playwright/test").Page,
  name: string
) {
  const response = await page.request.post("/api/b/1/accounts", {
    data: {
      name,
      type: "liability",
      subtype: "credit_card",
    },
  });

  expect(response.ok()).toBeTruthy();
  return response.json();
}

test.describe("account management", () => {
  test("displays chart of accounts", async ({ page }) => {
    await page.goto("/b/1/accounts");
    await expect(
      page.getByRole("heading", { name: "Chart of Accounts" })
    ).toBeVisible();
    await expect(page.getByText("Checking")).toBeVisible();
    await expect(page.getByText("Savings")).toBeVisible();
  });

  test("creates a new account", async ({ page }) => {
    const accountName = uniqueName("Credit Card");

    await page.goto("/b/1/accounts");
    await page.getByRole("button", { name: "New Account" }).click();
    await expect(
      page.getByRole("heading", { name: "New Account" })
    ).toBeVisible();

    await page.getByLabel("Account Name").fill(accountName);
    await page.getByLabel("Account Type").selectOption("liability");
    await page.getByLabel("Subtype").selectOption("credit_card");
    await page.getByRole("button", { name: "Create Account" }).click();

    await expect(
      page.getByRole("button", { name: "Create Account" })
    ).not.toBeVisible();
    await expect(page.getByRole("link", { name: accountName, exact: true })).toBeVisible();
  });

  test("edits an account", async ({ page }) => {
    const originalName = uniqueName("Credit Card");
    const updatedName = uniqueName("Visa Card");
    await createLiabilityAccount(page, originalName);

    await page.goto("/b/1/accounts");

    const row = accountRow(page, originalName);
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Edit" }).click();

    await expect(
      page.getByRole("heading", { name: "Edit Account" })
    ).toBeVisible();
    await page.getByLabel("Account Name").clear();
    await page.getByLabel("Account Name").fill(updatedName);
    await page.getByRole("button", { name: "Save Changes" }).click();

    await expect(
      page.getByRole("button", { name: "Save Changes" })
    ).not.toBeVisible();
    await expect(page.getByRole("link", { name: updatedName, exact: true })).toBeVisible();
  });

  test("toggles account inactive", async ({ page }) => {
    const accountName = uniqueName("Visa Card");
    await createLiabilityAccount(page, accountName);

    await page.goto("/b/1/accounts");

    const row = accountRow(page, accountName);
    await expect(row).toBeVisible();
    await row.hover();
    await row.locator("label[title='Mark as inactive']").click({ force: true });

    await expect(page.getByRole("link", { name: accountName, exact: true })).not.toBeVisible();

    await page.getByLabel("Show Inactive").check();
    await expect(page.getByRole("link", { name: accountName, exact: true })).toBeVisible();
  });

  test("deletes an account with no transactions", async ({ page }) => {
    const accountName = uniqueName("Disposable Card");
    await createLiabilityAccount(page, accountName);

    await page.goto("/b/1/accounts");

    page.on("dialog", (dialog) => dialog.accept());

    const row = accountRow(page, accountName);
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Delete" }).click();

    await expect(page.getByRole("link", { name: accountName, exact: true })).toHaveCount(0);
  });
});
