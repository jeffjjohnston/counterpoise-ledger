import { test, expect } from "@playwright/test";

for (const width of [1024, 1440]) {
  for (const [account, column] of [["Checking", "Payee"], ["Brokerage", "Activity"]]) {
    test(`${account} register keeps its flexible column usable at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/b/1");
      await page.getByRole("link", { name: account, exact: true }).first().click();
      const header = page.getByRole("columnheader", { name: column, exact: true });
      await expect(header).toBeVisible();
      // Measure actual browser layout, not the spelling of utility classes.
      const bounds = await header.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.width).toBeGreaterThanOrEqual(100);
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      await expect(page.getByRole("columnheader", { name: "Balance", exact: true })).toBeVisible();
    });
  }
}
