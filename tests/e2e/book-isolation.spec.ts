import { smallBookTest as test, expect } from "./fixtures";

test("account data stays in its book when switching between two populated books", async ({ page, bookId }) => {
  const name = "Isolated Reserve";
  const created = await page.request.post(`/api/b/${bookId}/accounts`, {
    data: { name, type: "asset", subtype: "bank" },
  });
  expect(created.ok()).toBe(true);

  await page.goto(`/b/${bookId}/accounts`);
  await expect(page.getByRole("heading", { name: "Chart of Accounts" })).toBeVisible();
  await expect(page.getByRole("link", { name, exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Brokerage", exact: true })).toHaveCount(0);

  await page.goto("/b/1/accounts");
  await expect(page.getByRole("link", { name: "Brokerage", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name, exact: true })).toHaveCount(0);

  await page.goto(`/b/${bookId}/accounts`);
  await expect(page.getByRole("link", { name, exact: true })).toBeVisible();
});
