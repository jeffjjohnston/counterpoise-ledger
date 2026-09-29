import postgres from "postgres";
import { test, expect } from "./fixtures";
import { e2eDatabaseUrl } from "./database";

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
  const sql = postgres(e2eDatabaseUrl(), { max: 1 });
  try {
    const [checking] = await sql`select id from accounts where book_id = ${bookId} and name = 'Checking'`;
    const [expense] = await sql`select id from accounts where book_id = ${bookId} and name = 'Groceries'`;
    const txn = await sql.begin(async (tx) => {
      const [row] = await tx`insert into transactions (book_id, date, description, check_number, created_at, updated_at)
        values (${bookId}, current_date::text, 'External live entry', 'External live entry', now(), now()) returning id`;
      await tx`insert into transaction_splits (book_id, transaction_id, account_id, amount)
        values (${bookId}, ${row.id}, ${checking.id}, -1234), (${bookId}, ${row.id}, ${expense.id}, 1234)`;
      return row;
    });
    await page.goto(`/b/${bookId}/transactions?accountId=${checking.id}`);
    await expect(page.locator("tbody tr").filter({ hasText: "External live entry" })).toBeVisible();
    await page.waitForFunction(() => (window as unknown as { bookEventCounts: { ready: number } }).bookEventCounts.ready > 0);
    await sql`update transactions set description = 'Changed remotely', check_number = 'Changed remotely' where id = ${txn.id} and book_id = ${bookId}`;
    const row = page.locator("tbody tr").filter({ hasText: "Changed remotely" });
    await expect(row).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { bookEventCounts: { connections: number } }).bookEventCounts.connections)).toBe(1);

    const registerScroll = page.locator("main .overflow-y-auto.bg-surface");
    await registerScroll.evaluate((element) => { element.scrollTop = 300; });
    await expect.poll(() => registerScroll.evaluate((element) => element.scrollTop)).toBe(300);
    await sql`update transaction_splits set amount = case when amount < 0 then -1567 else 1567 end
      where transaction_id = ${txn.id} and book_id = ${bookId}`;
    await expect(page.getByTestId(`transaction-amount-${txn.id}`)).toHaveText(/15\.67/);
    expect(await registerScroll.evaluate((element) => element.scrollTop)).toBe(300);
    await registerScroll.evaluate((element) => { element.scrollTop = 0; });

    await row.click();
    await page.getByLabel("Description").fill("Unsaved draft survives");
    const before = await page.evaluate(() => (window as unknown as { bookEventCounts: { change: number } }).bookEventCounts.change);
    await sql`update transactions set description = 'Queued during editing', check_number = 'Queued during editing' where id = ${txn.id} and book_id = ${bookId}`;
    await page.waitForFunction((count) => (window as unknown as { bookEventCounts: { change: number } }).bookEventCounts.change > count, before);
    await expect(page.getByLabel("Description")).toHaveValue("Unsaved draft survives");
    await page.keyboard.press("Escape");
    await expect(page.locator("tbody tr").filter({ hasText: "Queued during editing" })).toBeVisible();

    await sql.begin(async (tx) => {
      const [token] = await tx`insert into plaid_tokens (book_id, financial_institution, item_id, access_token, is_demo, created_at, updated_at)
        values (${bookId}, 'Test institution', ${`live-${bookId}`}, 'synthetic-test-token', true, now(), now()) returning id`;
      const [account] = await tx`insert into plaid_accounts (book_id, token_id, plaid_account_id, name, type, counterpoise_account_id, created_at, updated_at)
        values (${bookId}, ${token.id}, ${`live-account-${bookId}`}, 'Checking', 'depository', ${checking.id}, now(), now()) returning id`;
      await tx`insert into plaid_transaction_reconciliation
        (book_id, plaid_account_link_id, plaid_transaction_id, date, amount_cents, name, raw_json, first_seen_at, last_seen_at, created_at, updated_at)
        values (${bookId}, ${account.id}, ${`live-txn-${bookId}`}, current_date::text, 125, 'External pending purchase', '{}', now(), now(), now(), now())`;
    });
    await expect(page.getByRole("link", { name: "Sync 1", exact: true })).toBeVisible();
    await expect(page.locator("tbody tr").filter({ hasText: "External pending purchase" })).toBeVisible();

    const resets = await page.evaluate(() => (window as unknown as { bookEventCounts: { reset: number } }).bookEventCounts.reset);
    // Disconnect ONLY the listener owned by this isolated E2E database. Commit
    // a write across that gap; the server must LISTEN again and send reset so
    // the browser catches up even when the NOTIFY itself was missed. Node
    // (postgres.js) and Rust (SQLx) spell the LISTEN in different case.
    const listeners = await sql`select pid from pg_stat_activity where datname = current_database()
      and lower(query) = 'listen "counterpoise_changes"' and pid <> pg_backend_pid()`;
    expect(listeners).toHaveLength(1);
    await sql.begin(async (tx) => {
      await tx`update transactions set description = 'Changed across reconnect', check_number = 'Changed across reconnect'
        where id = ${txn.id} and book_id = ${bookId}`;
      const [terminated] = await tx`select pg_terminate_backend(${listeners[0].pid}) as stopped`;
      expect(terminated.stopped).toBe(true);
    });
    await page.waitForFunction((count) => (window as unknown as { bookEventCounts: { reset: number } }).bookEventCounts.reset > count, resets);
    await expect(page.locator("tbody tr").filter({ hasText: "Changed across reconnect" })).toBeVisible();
    // One stream serves the whole test. The server re-LISTENs behind it, and
    // the proxy must not cut it: a timeout on the proxied body once did.
    expect(await page.evaluate(() => (window as unknown as { bookEventCounts: { connections: number; error: number } }).bookEventCounts))
      .toMatchObject({ connections: 1, error: 0 });
    await page.screenshot({ path: "test-results/book-live-updates.png" });
  } finally {
    await sql.end();
  }
});
