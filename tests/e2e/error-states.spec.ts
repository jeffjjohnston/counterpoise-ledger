import { test, expect } from "@playwright/test";

test.describe("error and empty states", () => {
  test("accessing a non-existent book shows error or redirects", async ({ page }) => {
    // Book ID 99999 doesn't exist
    const response = await page.request.get("/api/b/99999/accounts");
    // Should return 403 or 404
    expect([403, 404]).toContain(response.status());
  });

  test("unauthenticated API request returns 401", async ({ browser }) => {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();

    const response = await page.request.get("/api/b/1/accounts");
    expect(response.status()).toBe(401);

    await context.close();
  });

  test("empty book shows no-data states on dashboard", async ({ page }) => {
    // Create a fresh empty book
    const createRes = await page.request.post("/api/books", {
      data: { name: `Empty ${Date.now()}` },
    });
    expect(createRes.ok()).toBeTruthy();
    const book = await createRes.json();

    await page.goto(`/b/${book.id}`);
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

    // Recent transactions should show empty state
    await expect(page.getByText("No transactions yet")).toBeVisible();
  });

  test("empty book securities page shows empty list", async ({ page }) => {
    const createRes = await page.request.post("/api/books", {
      data: { name: `Empty Sec ${Date.now()}` },
    });
    expect(createRes.ok()).toBeTruthy();
    const book = await createRes.json();

    await page.goto(`/b/${book.id}/securities`);
    await expect(
      page.getByRole("heading", { name: "Securities", exact: true })
    ).toBeVisible();

    // No securities should be listed — seed data only exists in book 1
    await expect(page.getByText("VTI")).not.toBeVisible();
  });
});
