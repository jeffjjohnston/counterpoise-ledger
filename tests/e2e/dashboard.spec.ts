import { test, expect } from "@playwright/test";
import { emptyBookTest } from "./fixtures";

/** The local date `offset` days from today, as the dashboard reads "today". */
function localDate(offset: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

test.describe("dashboard", () => {
  // The test writes its rows in an empty book, so each value is known:
  //   3 days ago  Acme Payroll   Checking +2,500.00   Salary   -2,500.00
  //   2 days ago  Corner Market  Groceries  +123.45   Visa       -123.45
  //   1 day ago   Visa Payment   Visa        +50.00   Checking    -50.00
  //   tomorrow    Landlord       Groceries  +999.00   Checking   -999.00
  // The dashboard reads up to today, so the row of tomorrow is not counted.
  //   Assets      = Checking 2,500.00 - 50.00               = $2,450.00
  //   Liabilities = Visa 123.45 - 50.00 (shown positive)    = $73.45
  //   Net Worth   = 2,450.00 - 73.45                        = $2,376.55
  // Recent Transactions shows each row with its largest split, newest first.
  emptyBookTest("summary cards and recent transactions show the book's values", async ({ page, request, bookId }) => {
    const post = async (path: string, data: unknown) => {
      const response = await request.post(path, { data });
      expect(response.status(), `POST ${path}: ${await response.text()}`).toBe(200);
      return response.json();
    };
    const account = async (name: string, type: string, subtype?: string) =>
      (await post(`/api/b/${bookId}/accounts`, { name, type, subtype })).id as number;
    const checking = await account("Checking", "asset", "bank");
    const visa = await account("Visa", "liability", "credit_card");
    const salary = await account("Salary", "income");
    const groceries = await account("Groceries", "expense");
    const transaction = (offset: number, payeeName: string, splits: Array<[number, number]>) =>
      post(`/api/b/${bookId}/transactions`, {
        date: localDate(offset),
        payeeName,
        splits: splits.map(([accountId, amount]) => ({ accountId, amount })),
      });
    await transaction(-3, "Acme Payroll", [[checking, 250000], [salary, -250000]]);
    await transaction(-2, "Corner Market", [[groceries, 12345], [visa, -12345]]);
    await transaction(-1, "Visa Payment", [[visa, 5000], [checking, -5000]]);
    await transaction(1, "Landlord", [[groceries, 99900], [checking, -99900]]);

    await page.goto(`/b/${bookId}`);
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

    // Each summary card holds its label and its amount, and nothing more.
    const summaryCard = (label: string) => page.locator("p", { hasText: new RegExp(`^${label}$`) }).locator("..");
    await expect(summaryCard("Assets")).toHaveText(/^Assets\s*\$2,450\.00$/);
    await expect(summaryCard("Liabilities")).toHaveText(/^Liabilities\s*\$73\.45$/);
    await expect(summaryCard("Net Worth")).toHaveText(/^Net Worth\s*\$2,376\.55$/);

    // The card of Recent Transactions is the largest element that holds its
    // heading and not the page heading. Only the rows in that card count.
    const recent = page
      .locator("div")
      .filter({ has: page.getByRole("heading", { name: "Recent Transactions" }) })
      .filter({ hasNot: page.getByRole("heading", { name: "Dashboard" }) })
      .first();
    const rows = recent.getByRole("link").filter({ hasNotText: "View All" });
    await expect(rows).toHaveText([
      /Visa Payment.*\$50\.00$/,
      /Corner Market.*\$123\.45$/,
      /Acme Payroll.*\$2,500\.00$/,
    ]);
  });

  test("displays account groups", async ({ page }) => {
    await page.goto("/b/1");
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

    // Asset accounts from seed data — use exact link match to avoid strict mode violation
    await expect(page.getByRole("link", { name: "Checking", exact: true }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Savings", exact: true }).first()).toBeVisible();
  });

  test("View All link navigates to transactions page", async ({ page }) => {
    await page.goto("/b/1");
    await page.getByText("View All").click();
    await expect(page).toHaveURL(/\/b\/1\/transactions/);
  });
});
