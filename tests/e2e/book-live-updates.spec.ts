import { test, expect } from "./fixtures";
import { exec, row, transaction } from "../helpers/sql";
import { toDateString } from "../../lib/formatters";

// Observe actual browser EventSource delivery, including reconnect, without
// replacing its network behavior. The writer below is outside the browser.
test("external commits refresh the register and badge, defer edits, and recover a listener disconnect", async ({ page, bookId }) => {
  await page.addInitScript(() => {
    const Native = window.EventSource;
    const counts = { ready: 0, reset: 0, change: 0, error: 0, connections: 0 };
    Object.assign(window, { bookEventCounts: counts });
    window.EventSource = class extends Native {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        counts.connections++;
        this.addEventListener("ready", () => counts.ready++);
        this.addEventListener("change", () => counts.change++);
        this.addEventListener("reset", () => counts.reset++);
        this.addEventListener("error", () => counts.error++);
      }
    };
  });
  const today = toDateString(new Date());
  const checking = await row<{ id: number }>("select id from accounts where book_id = $1 and name = 'Checking'", [bookId]);
  const expense = await row<{ id: number }>("select id from accounts where book_id = $1 and name = 'Groceries'", [bookId]);
  const txn = await transaction(async (tx) => {
    const created = await tx.insert<{ id: number }>("transactions", {
      bookId, date: today, description: "External live entry", checkNumber: "External live entry",
    });
    await tx.insertRows("transaction_splits", [
      { bookId, transactionId: created.id, accountId: checking.id, amount: -1234 },
      { bookId, transactionId: created.id, accountId: expense.id, amount: 1234 },
    ]);
    return created;
  });
  await page.goto(`/b/${bookId}/transactions?accountId=${checking.id}`);
  await expect(page.getByRole("table", { name: "Transactions" }).locator("tbody tr").filter({ hasText: "External live entry" })).toBeVisible();
  await page.waitForFunction(() => (window as unknown as { bookEventCounts: { ready: number } }).bookEventCounts.ready > 0);
  await exec("update transactions set description = 'Changed remotely', check_number = 'Changed remotely' where id = $1 and book_id = $2", [txn.id, bookId]);
  const changedRow = page.getByRole("table", { name: "Transactions" }).locator("tbody tr").filter({ hasText: "Changed remotely" });
  await expect(changedRow).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { bookEventCounts: { connections: number } }).bookEventCounts.connections)).toBe(1);

  const registerScroll = page.locator("main .overflow-y-auto.bg-surface");
  await registerScroll.evaluate((element) => { element.scrollTop = 300; });
  await expect.poll(() => registerScroll.evaluate((element) => element.scrollTop)).toBe(300);
  await exec(`update transaction_splits set amount = case when amount < 0 then -1567 else 1567 end
    where transaction_id = $1 and book_id = $2`, [txn.id, bookId]);
  await expect(page.getByTestId(`transaction-amount-${txn.id}`)).toHaveText(/15\.67/);
  expect(await registerScroll.evaluate((element) => element.scrollTop)).toBe(300);
  await registerScroll.evaluate((element) => { element.scrollTop = 0; });

  await changedRow.click();
  await page.getByLabel("Description").fill("Unsaved draft survives");
  const before = await page.evaluate(() => (window as unknown as { bookEventCounts: { change: number } }).bookEventCounts.change);
  await exec("update transactions set description = 'Queued during editing', check_number = 'Queued during editing' where id = $1 and book_id = $2", [txn.id, bookId]);
  await page.waitForFunction((count) => (window as unknown as { bookEventCounts: { change: number } }).bookEventCounts.change > count, before);
  await expect(page.getByLabel("Description")).toHaveValue("Unsaved draft survives");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("table", { name: "Transactions" }).locator("tbody tr").filter({ hasText: "Queued during editing" })).toBeVisible();

  await transaction(async (tx) => {
    const token = await tx.insert<{ id: number }>("plaid_tokens", {
      bookId, financialInstitution: "Test institution", itemId: `live-${bookId}`,
      accessToken: "synthetic-test-token", isDemo: true,
    });
    const account = await tx.insert<{ id: number }>("plaid_accounts", {
      bookId, tokenId: token.id, plaidAccountId: `live-account-${bookId}`, name: "Checking",
      type: "depository", counterpoiseAccountId: checking.id,
    });
    await tx.insert("plaid_transaction_reconciliation", {
      bookId, plaidAccountLinkId: account.id, plaidTransactionId: `live-txn-${bookId}`, date: today,
      amountCents: 125, name: "External pending purchase", rawJson: "{}",
    });
  });
  await expect(page.getByRole("link", { name: "Sync 1", exact: true })).toBeVisible();
  await expect(page.getByRole("table", { name: "Transactions" }).locator("tbody tr").filter({ hasText: "External pending purchase" })).toBeVisible();

  // An update from another process: the triggers count it, so the server
  // sends a hint although it did not write the row.
  await exec(`update transactions set description = 'Changed by another writer', check_number = 'Changed by another writer'
    where id = $1 and book_id = $2`, [txn.id, bookId]);
  await expect(page.getByRole("table", { name: "Transactions" }).locator("tbody tr").filter({ hasText: "Changed by another writer" })).toBeVisible();
  // One stream serves the whole test, and the proxy must not cut it: a
  // timeout on the proxied body once did.
  expect(await page.evaluate(() => (window as unknown as { bookEventCounts: { connections: number; error: number } }).bookEventCounts))
    .toMatchObject({ connections: 1, error: 0 });
  await page.screenshot({ path: "test-results/book-live-updates.png" });
});
