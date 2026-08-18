import { test, expect } from "@playwright/test";

test.describe("multi-book data isolation", () => {
  test("new book starts with no accounts or transactions", async ({ page }) => {
    // Create a new book via API
    const bookName = `Isolation Test ${Date.now()}`;
    const createRes = await page.request.post("/api/books", {
      data: { name: bookName },
    });
    expect(createRes.ok()).toBeTruthy();
    const book = await createRes.json();
    const newBookId = book.id;

    // Navigate to the new book's dashboard
    await page.goto(`/b/${newBookId}`);
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

    // Should show empty states — no asset accounts from book 1
    await expect(page.getByText("Checking")).not.toBeVisible();
    await expect(page.getByText("Savings")).not.toBeVisible();

    // Navigate to transactions — should be empty
    await page.goto(`/b/${newBookId}/transactions`);
    await expect(page.getByRole("heading", { name: "All Transactions" })).toBeVisible();
    // The account sidebar should have no accounts
    await expect(page.getByText("Checking")).not.toBeVisible();
  });

  test("book 1 data does not appear in book 2 accounts API", async ({ page }) => {
    const createRes = await page.request.post("/api/books", {
      data: { name: `API Isolation ${Date.now()}` },
    });
    expect(createRes.ok()).toBeTruthy();
    const book = await createRes.json();

    const accountsRes = await page.request.get(`/api/b/${book.id}/accounts`);
    expect(accountsRes.ok()).toBeTruthy();
    const accounts = await accountsRes.json();

    // New book should have zero accounts
    expect(accounts).toHaveLength(0);
  });
});
