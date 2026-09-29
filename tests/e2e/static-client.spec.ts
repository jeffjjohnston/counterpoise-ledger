import { test, expect } from "./fixtures";

// The client is a static build that the Rust server serves. Each page path
// gets index.html, and the router in the browser reads the IDs from the URL.

test.describe("static client", () => {
  test("a deep link to a page with an ID works after a reload", async ({ page, bookId }) => {
    await page.goto(`/b/${bookId}/securities`);
    await page.getByRole("link", { name: "Vanguard Total Stock Market" }).click();
    await expect(page).toHaveURL(new RegExp(`/b/${bookId}/securities/\\d+$`));
    const detailUrl = page.url();

    await page.reload();
    await expect(page).toHaveURL(detailUrl);
    await expect(page.getByRole("heading", { name: "Vanguard Total Stock Market" })).toBeVisible();

    // A new load of the same URL, as from a bookmark.
    await page.goto("about:blank");
    await page.goto(detailUrl);
    await expect(page.getByRole("heading", { name: "Vanguard Total Stock Market" })).toBeVisible();
  });

  test("Back returns to the previous page", async ({ page, bookId }) => {
    await page.goto(`/b/${bookId}/securities`);
    await page.getByRole("link", { name: "Vanguard Total Stock Market" }).click();
    await expect(page).toHaveURL(new RegExp(`/b/${bookId}/securities/\\d+$`));

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/b/${bookId}/securities$`));
    await expect(page.getByRole("heading", { name: "Securities", exact: true })).toBeVisible();
  });

  test("a path that no route has shows the not-found page", async ({ page }) => {
    await page.goto("/no-such-page");
    await expect(page.getByText("Page not found")).toBeVisible();
    await page.getByRole("link", { name: "Go to your books" }).click();
    await expect(page).toHaveURL("/");
  });

  test("a chunk that is not there gets 404, not the page", async ({ page }) => {
    const response = await page.request.get("/assets/no-such-chunk-000000.js");
    expect(response.status()).toBe(404);
  });
});
