import { test, expect } from "@playwright/test";

test.describe("account settings", () => {
  test("displays account page with username", async ({ page }) => {
    await page.goto("/account");
    await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();
    await expect(page.getByText("Signed in as testuser")).toBeVisible();
  });

  test("shows validation error for mismatched new passwords", async ({ page }) => {
    await page.goto("/account");
    await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();

    await page.getByLabel("Current password").fill("testpassword");
    await page.getByLabel("New password", { exact: true }).fill("newpass123");
    await page.getByLabel("Confirm new password").fill("different456");
    await page.getByRole("button", { name: "Change password" }).click();

    await expect(page.getByText("do not match")).toBeVisible();
  });

  test("shows error for wrong current password", async ({ page }) => {
    await page.goto("/account");
    await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();

    await page.getByLabel("Current password").fill("wrongpassword");
    await page.getByLabel("New password", { exact: true }).fill("newpass123");
    await page.getByLabel("Confirm new password").fill("newpass123");
    await page.getByRole("button", { name: "Change password" }).click();

    // Server should reject with an error
    await expect(page.locator("[class*='danger']")).toBeVisible();
  });

  test("successfully changes password", async ({ browser }) => {
    // Use a fresh user to avoid breaking the shared testuser
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();

    const username = `pwchange${Date.now()}`;
    await page.goto("/register");
    await expect(page.getByTestId("register-ready")).toBeVisible();
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Password", { exact: true }).fill("original123");
    await page.getByLabel("Confirm Password").fill("original123");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL("/");

    await page.goto("/account");
    await expect(page.getByText(`Signed in as ${username}`)).toBeVisible();

    await page.getByLabel("Current password").fill("original123");
    await page.getByLabel("New password", { exact: true }).fill("updated456");
    await page.getByLabel("Confirm new password").fill("updated456");
    await page.getByRole("button", { name: "Change password" }).click();

    await expect(page.getByText("Password updated successfully")).toBeVisible();

    await context.close();
  });

  test("displays API Keys section", async ({ page }) => {
    await page.goto("/account");
    await expect(page.getByRole("heading", { name: "API Keys" })).toBeVisible();
    await expect(page.getByText("MCP clients")).toBeVisible();
  });
});
