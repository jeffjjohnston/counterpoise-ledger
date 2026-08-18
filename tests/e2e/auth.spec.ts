import { test, expect, type Page } from "@playwright/test";

async function waitForLoginReady(page: Page) {
  await expect(page.getByTestId("login-ready")).toBeVisible();
}

test.describe("authentication", () => {
  test("redirects unauthenticated user to login", async ({ browser }) => {
    // Create a fresh context with no cookies
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();

    await page.goto("/b/1");
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("heading", { name: "Counterpoise" })).toBeVisible();

    await context.close();
  });

  test("logs in with valid credentials", async ({ browser }) => {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();

    await page.goto("/login");
    await waitForLoginReady(page);
    await page.getByLabel("Username").fill("testuser");
    await page.getByLabel("Password").fill("testpassword");
    await page.getByRole("button", { name: "Sign in" }).click();

    // Should redirect to home page (book selector)
    await expect(page).toHaveURL("/");
    await expect(page.getByRole("heading", { name: "Your Books" })).toBeVisible();

    await context.close();
  });

  test("shows error for invalid credentials", async ({ browser }) => {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();

    await page.goto("/login");
    await waitForLoginReady(page);
    await page.getByLabel("Username").fill("testuser");
    await page.getByLabel("Password").fill("wrongpassword");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByText("Invalid username or password")).toBeVisible();

    await context.close();
  });

  test("navigates between login and register", async ({ browser }) => {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();

    await page.goto("/login");
    await page.getByRole("link", { name: "Register" }).click();
    await expect(page).toHaveURL(/\/register/);
    await expect(page.getByTestId("register-ready")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Create account" })
    ).toBeVisible();

    await page.getByRole("link", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/login/);

    await context.close();
  });

  test("logs out and redirects to login", async ({ browser }) => {
    // Use a fresh login session so we don't destroy the shared global session
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();

    await page.goto("/login");
    await waitForLoginReady(page);
    await page.getByLabel("Username").fill("testuser");
    await page.getByLabel("Password").fill("testpassword");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Your Books" })).toBeVisible();

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login/);

    await context.close();
  });
});
