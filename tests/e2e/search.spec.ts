import { test, expect } from "@playwright/test";

test.describe("search", () => {
  test("searches for transactions by description", async ({ page }) => {
    await page.goto("/b/1/search");
    await expect(page.getByRole("heading", { name: "Search" })).toBeVisible();

    await page
      .getByPlaceholder(
        "Search transactions, accounts, payees, recurring rules..."
      )
      .fill("Salary");

    // Wait for search results (debounced)
    await expect(
      page.getByRole("heading", { name: /Transactions/ })
    ).toBeVisible();
    await expect(page.getByText("Salary (current month)")).toBeVisible();
  });

  test("searches for accounts by name", async ({ page }) => {
    await page.goto("/b/1/search");

    await page
      .getByPlaceholder(
        "Search transactions, accounts, payees, recurring rules..."
      )
      .fill("Checking");

    await expect(
      page.getByRole("heading", { name: /Accounts/ })
    ).toBeVisible();
    await expect(page.getByText("Checking")).toBeVisible();
  });

  test("searches for payees", async ({ page }) => {
    await page.goto("/b/1/search");

    await page
      .getByPlaceholder(
        "Search transactions, accounts, payees, recurring rules..."
      )
      .fill("Whole Foods");

    await expect(
      page.getByRole("heading", { name: /Payees/ })
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Whole Foods", exact: true })
    ).toBeVisible();
  });

  test("shows no results for non-existent term", async ({ page }) => {
    await page.goto("/b/1/search");

    await page
      .getByPlaceholder(
        "Search transactions, accounts, payees, recurring rules..."
      )
      .fill("xyznonexistent123");

    await expect(
      page.getByText(/No results found/)
    ).toBeVisible();
  });
});
