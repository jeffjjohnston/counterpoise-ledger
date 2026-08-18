import { test, expect } from "@playwright/test";

function uniqueName(prefix: string) {
  return `${prefix} ${Date.now()}-${Math.round(Math.random() * 1000)}`;
}

test.describe("book management", () => {
  test("displays existing books on home page", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Your Books" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Test Book" })).toBeVisible();
  });

  test("creates a new book", async ({ page }) => {
    const bookName = uniqueName("My New Book");

    await page.goto("/");
    await page.getByPlaceholder("Book name").fill(bookName);
    await page.getByRole("button", { name: "Create" }).click();

    await expect(page.getByRole("heading", { name: bookName })).toBeVisible();
  });

  test("renames a book", async ({ page }) => {
    const originalName = uniqueName("Book To Rename");
    const updatedName = uniqueName("Renamed Book");

    await page.goto("/");

    await page.getByPlaceholder("Book name").fill(originalName);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("heading", { name: originalName })).toBeVisible();

    await page.getByRole("button", { name: `Edit ${originalName}` }).click();
    await expect(page.getByText("Edit Book")).toBeVisible();

    await page.getByLabel("Book name").clear();
    await page.getByLabel("Book name").fill(updatedName);
    await page.getByRole("button", { name: "Save" }).click();

    await expect(page.getByRole("heading", { name: updatedName })).toBeVisible();
  });

  test("deletes a book", async ({ page }) => {
    const bookName = uniqueName("Book To Delete");

    await page.goto("/");

    await page.getByPlaceholder("Book name").fill(bookName);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("heading", { name: bookName })).toBeVisible();

    await page.getByRole("button", { name: `Edit ${bookName}` }).click();
    await page.getByRole("button", { name: "Delete book..." }).click();

    page.on("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Yes, permanently delete" }).click();

    await expect(page.getByRole("heading", { name: bookName })).toHaveCount(0);
  });

  test("navigates into a book", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Test Book" }).click();

    await expect(page).toHaveURL(/\/b\/1$/);
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  });
});
