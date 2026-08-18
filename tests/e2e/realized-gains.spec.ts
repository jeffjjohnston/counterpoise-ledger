import { test, expect } from "@playwright/test";

test.describe("realized gains and lot tracking", () => {
  test("realized gains report renders with short-term and long-term totals", async ({
    page,
  }) => {
    await page.goto("/b/1/reports/realized-gains");

    await expect(
      page.getByRole("heading", { name: "Realized Gains" })
    ).toBeVisible();

    // The fixture's BND sell spans both of its lots (see global-setup.ts):
    // lot 1 closes for a $600 long-term gain, lot 2 gives up 1 of its 2 shares
    // for a $100 short-term gain. Asserting both totals separately is the point
    // of the report — a single combined figure would be useless at tax time.
    await expect(page.getByTestId("short-term-total")).toHaveText("$100.00");
    await expect(page.getByTestId("long-term-total")).toHaveText("$600.00");
    await expect(page.getByTestId("proceeds-total")).toHaveText("$2,000.00");
    await expect(page.getByTestId("basis-total")).toHaveText("$1,300.00");

    // One row per lot disposed of, not one per sale — the whole reason the
    // allocations table exists. A single sell produced both rows below.
    const rows = page.locator("tbody tr").filter({ hasText: "BND" });
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: "Long" })).toHaveCount(1);
    await expect(rows.filter({ hasText: "Short" })).toHaveCount(1);

    await expect(page.getByText("No disposals in this date range.")).not.toBeVisible();
  });

  test("security lots tab renders open lots", async ({ page }) => {
    await page.goto("/b/1/securities");
    await page
      .getByRole("link", { name: "Vanguard Total Stock Market" })
      .click();
    await expect(page).toHaveURL(/\/b\/1\/securities\/\d+/);

    // Tabs.tsx renders plain <button> elements, not role="tab" — select by
    // visible label, matching the pattern already used for the Price History
    // and Transactions tabs in securities.spec.ts.
    await page.getByRole("button", { name: "Lots" }).click();

    // Scope to the Lots table specifically: the "Positions by Account" table
    // above the tabs also has a "Brokerage" cell and stays mounted regardless
    // of which tab is active, so an unscoped locator would match both.
    const lotsTable = page
      .locator("table")
      .filter({ has: page.getByRole("columnheader", { name: "Acquired" }) });
    await expect(lotsTable.getByRole("columnheader", { name: "Acquired" })).toBeVisible();

    // The seed book's Brokerage account holds 4 shares of VTI from a single
    // buy with no sells, so one open lot should be listed for it (not the
    // "No open lots." empty state).
    await expect(lotsTable.getByText("No open lots.")).not.toBeVisible();
    await expect(lotsTable.getByRole("cell", { name: "Brokerage" })).toBeVisible();
  });
});
