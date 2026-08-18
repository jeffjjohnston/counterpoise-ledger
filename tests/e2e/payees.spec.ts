import { test, expect } from "@playwright/test";

test.describe("payees", () => {
  test("displays payee list", async ({ page }) => {
    await page.goto("/b/1/payees");
    await expect(page.getByRole("heading", { name: "Payees" })).toBeVisible();

    // Seed payees should be visible
    await expect(page.getByText("Whole Foods")).toBeVisible();
    await expect(page.getByText("Acme Corp")).toBeVisible();
  });

  test("filters payees by search", async ({ page }) => {
    await page.goto("/b/1/payees");
    await expect(page.getByRole("heading", { name: "Payees" })).toBeVisible();

    await page.getByLabel("Search payees").fill("Whole");
    await expect(page.getByText("Whole Foods")).toBeVisible();
    await expect(page.getByText("Acme Corp")).not.toBeVisible();

    await page.getByLabel("Search payees").clear();
    await expect(page.getByText("Acme Corp")).toBeVisible();
  });

  test("sorts payees by column", async ({ page }) => {
    await page.goto("/b/1/payees");
    await expect(page.getByRole("heading", { name: "Payees" })).toBeVisible();

    // Click on the Payee column to sort
    await page.getByRole("button", { name: /Payee/ }).click();

    // Verify both payees still visible (we verify it doesn't crash)
    await expect(page.getByText("Whole Foods")).toBeVisible();
    await expect(page.getByText("Acme Corp")).toBeVisible();
  });

  test("navigates to payee detail page", async ({ page }) => {
    await page.goto("/b/1/payees");
    await expect(page.getByRole("heading", { name: "Payees" })).toBeVisible();

    await page.getByRole("link", { name: "Whole Foods" }).click();
    await expect(page).toHaveURL(/\/b\/1\/payees\/\d+/);

    // Payee detail should show payee name as heading
    await expect(page.getByRole("heading", { name: "Whole Foods" })).toBeVisible();
  });
});
