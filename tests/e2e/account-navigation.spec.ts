import { test, expect } from "@playwright/test";

test("account links navigate to filtered transactions", async ({ page }) => {
  await page.goto("/b/1");
  await page.getByRole("link", { name: "Checking" }).first().click();

  await expect(page).toHaveURL(/\/b\/1\/transactions\?accountId=\d+/);
  await expect(page.getByRole("heading", { name: "Checking" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Balance" })).toBeVisible();
});
