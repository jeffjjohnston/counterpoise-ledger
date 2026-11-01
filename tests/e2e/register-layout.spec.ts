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

// The "usually $x–$y" hint of a payee whose amount varies sits directly below
// the empty Amount field, inside its column, and clear of the "Filled from" chip.
for (const width of [1024, 1440]) {
  test(`Simple form's amount range hint sits below the Amount field at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/b/1");
    await page.getByRole("link", { name: "Checking", exact: true }).first().click();
    await page.getByRole("button", { name: "Simple", exact: true }).click();
    await page.getByPlaceholder("Payee", { exact: true }).fill("Whole Foods");
    const amount = page.getByRole("textbox", { name: "Amount", exact: true });
    const hint = page.getByText(/^usually \$/);
    const chip = page.getByRole("button", { name: /^Filled from:/ });
    await expect(hint).toBeVisible();
    await expect(amount).toHaveAccessibleDescription(/^usually \$/);
    const field = (await amount.boundingBox())!;
    const below = (await hint.boundingBox())!;
    const filled = (await chip.boundingBox())!;
    expect(below.y).toBeGreaterThanOrEqual(field.y + field.height);
    expect(below.y - (field.y + field.height)).toBeLessThanOrEqual(8);
    // The hint's box carries padding past the field; its text must not.
    const text = await hint.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const { x, width } = range.getBoundingClientRect();
      return { x, width };
    });
    expect(text.x).toBeGreaterThanOrEqual(field.x - 0.5);
    expect(text.x + text.width).toBeLessThanOrEqual(field.x + field.width + 0.5);
    expect(filled.x + filled.width).toBeLessThanOrEqual(text.x);
  });
}
