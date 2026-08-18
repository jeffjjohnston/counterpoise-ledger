import { test, expect, type Page } from "@playwright/test";

function uniqueUsername() {
  return `user${Date.now()}${Math.round(Math.random() * 1000)}`;
}

async function waitForRegisterReady(page: Page) {
  await expect(page.getByTestId("register-ready")).toBeVisible();
}

test.describe("registration", () => {
  test("registers a new user and redirects to home", async ({ browser }) => {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();

    const username = uniqueUsername();

    await page.goto("/register");
    await waitForRegisterReady(page);
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Password", { exact: true }).fill("testpass123");
    await page.getByLabel("Confirm Password").fill("testpass123");
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(page).toHaveURL("/");
    await expect(page.getByRole("heading", { name: "Your Books" })).toBeVisible();

    await context.close();
  });

  test("shows error for mismatched passwords", async ({ browser }) => {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();

    await page.goto("/register");
    await waitForRegisterReady(page);
    await page.getByLabel("Username").fill(uniqueUsername());
    await page.getByLabel("Password", { exact: true }).fill("testpass123");
    await page.getByLabel("Confirm Password").fill("different456");
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(page.getByText("Passwords do not match")).toBeVisible();

    await context.close();
  });

  test("shows error for duplicate username", async ({ browser }) => {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();

    // "testuser" is the seed user — already exists
    await page.goto("/register");
    await waitForRegisterReady(page);
    await page.getByLabel("Username").fill("testuser");
    await page.getByLabel("Password", { exact: true }).fill("testpass123");
    await page.getByLabel("Confirm Password").fill("testpass123");
    await page.getByRole("button", { name: "Create account" }).click();

    // Should display an error (exact text depends on API response)
    await expect(page.locator("[class*='danger']")).toBeVisible();

    await context.close();
  });
});
