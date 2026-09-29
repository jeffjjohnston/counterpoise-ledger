import { emptyBookTest as test, expect } from "./fixtures";

test.describe("empty states", () => {
  test("empty book shows no-data states on dashboard", async ({ page, bookId }) => {
    await page.goto(`/b/${bookId}`);
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await expect(page.getByText("No asset accounts")).toBeVisible();
    await expect(page.getByText("No transactions yet")).toBeVisible();
  });

  test("empty book securities page shows empty list", async ({ page, bookId }) => {
    await page.goto(`/b/${bookId}/securities`);
    await expect(
      page.getByRole("heading", { name: "Securities", exact: true })
    ).toBeVisible();
    await expect(page.getByText("No securities yet.")).toBeVisible();
  });
});
