import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

// Helper: find the inactive security row that contains the given security name
function securityRow(page: import("@playwright/test").Page, name: string) {
  return page
    .getByTestId("security-row")
    .filter({ has: page.getByRole("link", { name, exact: true }) });
}

function uniqueName(prefix: string) {
  return `${prefix} ${Date.now()}-${Math.round(Math.random() * 1000)}`;
}

async function createSecurity(
  page: import("@playwright/test").Page,
  name: string,
  symbol: string
) {
  const response = await page.request.post("/api/b/1/securities", {
    data: {
      name,
      symbol,
      securityType: "etf",
    },
  });

  expect(response.ok()).toBeTruthy();
  return response.json();
}

test.describe("securities", () => {
  test("displays securities list", async ({ page }) => {
    await page.goto("/b/1/securities");
    await expect(
      page.getByRole("heading", { name: "Securities", exact: true })
    ).toBeVisible();

    // Seed security (VTI has no positions, so it's in Inactive Securities)
    await expect(page.getByText("Vanguard Total Stock Market")).toBeVisible();
    await expect(page.getByText("VTI")).toBeVisible();
  });

  test("creates a new security", async ({ page }) => {
    const securityName = uniqueName("Vanguard Bond Fund");
    const symbol = `B${Date.now().toString().slice(-4)}`;

    await page.goto("/b/1/securities");

    await page.getByRole("button", { name: "Add Security" }).click();
    await expect(
      page.getByRole("heading", { name: "Add Security" })
    ).toBeVisible();

    await page.getByLabel("Security Name").fill(securityName);
    await page.getByLabel("Symbol").fill(symbol);
    await page.getByLabel("Security Type").selectOption("etf");
    await page.getByRole("button", { name: "Add Security" }).last().click();

    await expect(
      page.getByRole("heading", { name: "Add Security" })
    ).not.toBeVisible();
    await expect(page.getByText(securityName)).toBeVisible();
  });

  test("edits a security", async ({ page }) => {
    const originalName = uniqueName("Vanguard Bond Fund");
    const updatedName = uniqueName("Vanguard Total Bond");
    const symbol = `B${Date.now().toString().slice(-4)}`;
    await createSecurity(page, originalName, symbol);

    await page.goto("/b/1/securities");

    const row = securityRow(page, originalName);
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Edit" }).click();

    await expect(
      page.getByRole("heading", { name: "Edit Security" })
    ).toBeVisible();
    await page.getByLabel("Security Name").clear();
    await page.getByLabel("Security Name").fill(updatedName);
    await page.getByRole("button", { name: "Save Changes" }).click();

    await expect(
      page.getByRole("heading", { name: "Edit Security" })
    ).not.toBeVisible();
    await expect(page.getByText(updatedName)).toBeVisible();
  });

  test("deletes a security with no transactions", async ({ page }) => {
    const securityName = uniqueName("Disposable Security");
    const symbol = `D${Date.now().toString().slice(-4)}`;
    await createSecurity(page, securityName, symbol);

    await page.goto("/b/1/securities");

    page.on("dialog", (dialog) => dialog.accept());

    const row = securityRow(page, securityName);
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Delete" }).click();

    await expect(page.getByText(securityName)).toHaveCount(0);
  });

  test("navigates to security detail page", async ({ page }) => {
    await page.goto("/b/1/securities");

    await page
      .getByRole("link", { name: "Vanguard Total Stock Market" })
      .click();
    await expect(page).toHaveURL(/\/b\/1\/securities\/\d+/);
    await expect(page.getByText("VTI")).toBeVisible();
  });

  test("security detail page shows position data", async ({ page }) => {
    await page.goto("/b/1/securities");
    await page.getByRole("link", { name: "Vanguard Total Stock Market" }).click();
    await expect(page).toHaveURL(/\/b\/1\/securities\/\d+/);

    // Header info
    await expect(page.getByRole("heading", { name: "Vanguard Total Stock Market" })).toBeVisible();
    await expect(page.getByText("VTI")).toBeVisible();
    await expect(page.getByText("ETF")).toBeVisible();

    // Summary cards
    await expect(page.getByText("Current Price")).toBeVisible();
    await expect(page.getByText("Open Positions")).toBeVisible();
    await expect(page.getByText("Total Shares")).toBeVisible();

    // Positions by Account table — seed has Brokerage holding VTI
    await expect(page.getByRole("heading", { name: "Positions by Account" })).toBeVisible();
    await expect(page.getByText("Brokerage")).toBeVisible();
  });

  test("security detail page shows price history tab", async ({ page }) => {
    await page.goto("/b/1/securities");
    await page.getByRole("link", { name: "Vanguard Total Stock Market" }).click();
    await expect(page).toHaveURL(/\/b\/1\/securities\/\d+/);

    // Price History tab is active by default (rendered as a button)
    await expect(page.getByRole("button", { name: "Price History" })).toBeVisible();

    // Seed data has one price entry — $250.00 (in the price history table cell)
    await expect(page.getByRole("cell", { name: "$250.00" })).toBeVisible();
  });

  test("downloads active securities as CSV", async ({ page }) => {
    await page.goto("/b/1/securities");

    // The seed has an active VTI position, so the Download CSV button is shown.
    const downloadButton = page.getByRole("button", { name: "Download CSV" });
    await expect(downloadButton).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      downloadButton.click(),
    ]);

    expect(download.suggestedFilename()).toMatch(/^active-securities-\d{4}-\d{2}-\d{2}\.csv$/);

    const path = await download.path();
    const content = await readFile(path, "utf8");
    const [header, ...rows] = content.split("\n");
    expect(header).toBe(
      "Name,Symbol,Type,Shares,Cost Basis,Current Price,Price Date,Income,Market Value"
    );
    // VTI row from the seed should be present.
    const vtiRow = rows.find((row) => row.startsWith("Vanguard Total Stock Market,VTI,"));
    expect(vtiRow).toBeDefined();
  });

  test("security detail page shows transactions tab", async ({ page }) => {
    await page.goto("/b/1/securities");
    await page.getByRole("link", { name: "Vanguard Total Stock Market" }).click();
    await expect(page).toHaveURL(/\/b\/1\/securities\/\d+/);

    // Switch to Transactions tab (rendered as a button)
    await page.getByRole("button", { name: "Transactions" }).click();

    // Seed data has a Buy transaction for VTI
    await expect(page.getByText("Buy")).toBeVisible();
  });
});
