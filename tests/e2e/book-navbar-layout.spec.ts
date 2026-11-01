import { test, expect, type Locator, type Page } from "@playwright/test";
import { emptyBookTest } from "./fixtures";

// The book navbar changes from the menu button to the desktop links at
// Tailwind's `lg` (1024px). MOBILE_BREAKPOINT in hooks/useIsMobile.ts must
// agree (guides/components-and-ui.md). The desktop links need about 1019px,
// so they must not show at `md` (768px), the width of a portrait iPad. These
// checks measure the layout in a real browser, not the utility classes.
// Only the wordmark test writes, and it uses its own book.

const PRIMARY_LINKS = ["Dashboard", "Transactions", "Recurring", "Securities", "Sync"];

async function openNavbar(page: Page, width: number, bookId = 1, bookName = "Test Book"): Promise<Locator> {
  await page.setViewportSize({ width, height: 800 });
  await page.goto(`/b/${bookId}`);
  const nav = page.getByRole("navigation");
  // The book name shows when the navbar has its data.
  await expect(nav.getByRole("button", { name: "Open book menu" })).toContainText(bookName);
  return nav;
}

/** The document must not scroll sideways: a control that does not fit makes it scroll. */
async function expectNoSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

// 768px is Tailwind's `md` and a portrait iPad. 1023px is the widest mobile
// width.
for (const width of [768, 1023]) {
  test(`navbar shows the menu button and no desktop links at ${width}px`, async ({ page }) => {
    const nav = await openNavbar(page, width);
    await expect(nav.getByRole("button", { name: "Open menu" })).toBeVisible();
    for (const name of PRIMARY_LINKS) {
      await expect(nav.getByRole("link", { name, exact: true }), name).toBeHidden();
    }
    await expect(nav.getByRole("button", { name: "More" })).toBeHidden();
    await expect(nav.getByRole("link", { name: "Search" })).toBeHidden();
    await expect(nav.getByRole("button", { name: "Open user menu" })).toBeHidden();
    await expectNoSidewaysScroll(page);
  });
}

for (const width of [1024, 1440]) {
  test(`navbar shows the desktop links and no menu button at ${width}px`, async ({ page }) => {
    const nav = await openNavbar(page, width);
    for (const name of PRIMARY_LINKS) {
      await expect(nav.getByRole("link", { name, exact: true }), name).toBeVisible();
    }
    await expect(nav.getByRole("button", { name: "More" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Search" })).toBeVisible();
    await expect(nav.getByRole("button", { name: "Open menu" })).toBeHidden();
    // The last control on the right must be fully on the screen.
    const userMenu = nav.getByRole("button", { name: "Open user menu" });
    await expect(userMenu).toBeVisible();
    const box = await userMenu.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    await expectNoSidewaysScroll(page);
  });
}

// The brand shares a row with the book menu and every desktop link. When the
// row was too narrow, the brand lost width first and the wordmark showed as
// "Counterpois". 1024px is the narrowest width with the desktop links. A long
// book name makes the book menu as wide as its limit, so the row is too
// narrow at that width.
emptyBookTest("navbar shows the whole wordmark at the narrowest desktop width", async ({ page, request, bookId }) => {
  const name = "Household Finances and Retirement Planning";
  const renamed = await request.put(`/api/books/${bookId}`, { data: { name } });
  expect(renamed.status()).toBe(200);
  const nav = await openNavbar(page, 1024, bookId, name);
  const brand = nav.getByRole("link", { name: "Counterpoise" });
  const wordmark = brand.getByText("Counterpoise", { exact: true });
  await expect(wordmark).toBeVisible();

  // Neither the word nor its link is narrower than its content.
  for (const element of [brand, wordmark]) {
    const size = await element.evaluate((node) => ({ scroll: node.scrollWidth, client: node.clientWidth }));
    expect(size.scroll).toBeLessThanOrEqual(size.client);
  }

  // The book menu does not cover the end of the word.
  const word = await wordmark.boundingBox();
  const bookMenu = await nav.getByRole("button", { name: "Open book menu" }).boundingBox();
  expect(word).not.toBeNull();
  expect(bookMenu).not.toBeNull();
  expect(word!.x + word!.width).toBeLessThanOrEqual(bookMenu!.x);

  // The book menu ends before the first desktop link starts. The right
  // cluster does not shrink, so the book menu is the control that must give
  // up width.
  const firstLink = await nav.getByRole("link", { name: PRIMARY_LINKS[0], exact: true }).boundingBox();
  expect(firstLink).not.toBeNull();
  expect(bookMenu!.x + bookMenu!.width).toBeLessThanOrEqual(firstLink!.x);

  // The book list opens below the button, not over it. "Manage books..." is
  // in the last section of the list, and that section's parent is the list.
  await nav.getByRole("button", { name: "Open book menu" }).click();
  const list = await nav.getByRole("link", { name: "Manage books..." }).locator("xpath=../..").boundingBox();
  expect(list).not.toBeNull();
  expect(list!.y).toBeGreaterThanOrEqual(bookMenu!.y + bookMenu!.height);
});
