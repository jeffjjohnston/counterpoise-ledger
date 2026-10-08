import { test, expect } from "@playwright/test";

for (const width of [1024, 1440]) {
  for (const [account, column] of [["Checking", "Payee"], ["Brokerage", "Activity"]]) {
    test(`${account} register keeps its flexible column usable at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/b/1");
      await page.getByRole("link", { name: account, exact: true }).first().click();
      const header = page.getByRole("table", { name: "Transactions" }).getByRole("columnheader", { name: column, exact: true });
      await expect(header).toBeVisible();
      // Measure actual browser layout, not the spelling of utility classes.
      const bounds = await header.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.width).toBeGreaterThanOrEqual(100);
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      await expect(page.getByRole("table", { name: "Transactions" }).getByRole("columnheader", { name: "Balance", exact: true })).toBeVisible();
    });
  }
}

// Issue report 39: the Simple form's Add button was taller than the fields
// beside it, sat 7px higher, and stretched across three register columns.
for (const width of [1024, 1440]) {
  test(`Simple form's Add button matches the field row at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/b/1");
    await page.getByRole("link", { name: "Checking", exact: true }).first().click();
    await page.getByRole("button", { name: "Simple", exact: true }).click();
    const amount = page.getByRole("textbox", { name: "Amount", exact: true });
    const add = page.getByRole("button", { name: "Add Transaction", exact: true });
    await expect(add).toBeVisible();
    const field = await amount.boundingBox();
    const button = await add.boundingBox();
    expect(field).not.toBeNull();
    expect(button).not.toBeNull();
    expect(Math.abs(button!.y - field!.y)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(button!.height - field!.height)).toBeLessThanOrEqual(0.5);
    expect(button!.width).toBeLessThan(field!.width);
  });
}

// The register sizes itself as the viewport minus the navbar height. When the
// navbar was 1px taller than that height, the document could scroll: a wheel
// over the sidebar moved on to the page when the sidebar reached its end.
for (const width of [390, 1440]) {
  test(`register page fills the viewport without a document scroll at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/b/1");
    await page.getByRole("link", { name: "Checking", exact: true }).first().click();
    await expect(page).toHaveURL(/\/b\/1\/transactions\?accountId=\d+/);
    await expect(page.getByRole("heading", { name: "Checking", exact: true })).toBeVisible();
    const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    expect(scrollHeight).toBeLessThanOrEqual(800);
  });
}
