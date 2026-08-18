import { test, expect } from "@playwright/test";

test.describe("investment account navigation - no flickering", () => {
  test("positions section DOM node is preserved when switching between investment accounts", async ({
    page,
  }) => {
    await page.goto("/b/1/transactions");

    // Navigate to first investment account and wait for positions to load
    await page.getByRole("link", { name: "Brokerage" }).click();
    await expect(
      page.getByTestId("investment-positions-section")
    ).toBeVisible({ timeout: 10000 });
    await expect(
      page.getByTestId("investment-positions-loading")
    ).not.toBeVisible({ timeout: 10000 });

    // Capture a direct reference to the DOM node
    const sectionHandle = await page
      .getByTestId("investment-positions-section")
      .elementHandle();

    // Navigate to second investment account
    await page.getByRole("link", { name: "Retirement" }).click();
    await expect(
      page.getByRole("heading", { name: "Retirement" })
    ).toBeVisible();

    // The DOM node must still be attached — if the scroll container was remounted
    // due to a key change, this element would be detached from the document
    const isStillInDocument = await sectionHandle!.evaluate((el) =>
      document.contains(el)
    );
    expect(isStillInDocument).toBe(true);
  });

  test("positions section shows stale data instead of loading skeleton when switching between investment accounts", async ({
    page,
  }) => {
    await page.goto("/b/1/transactions");

    // Navigate to first investment account and wait for positions to fully load
    await page.getByRole("link", { name: "Brokerage" }).click();
    await expect(
      page.getByTestId("investment-positions-section")
    ).toBeVisible({ timeout: 10000 });
    await expect(
      page.getByTestId("investment-positions-loading")
    ).not.toBeVisible({ timeout: 10000 });

    // Block positions requests so loading state is sustained
    await page.route("**/investments/positions**", () => {
      // Intentionally never resolved — keeps positionsLoading=true
    });

    // Wait for the blocked request to be intercepted (proves the fetch effect ran
    // and setPositionsLoading(true) has been called)
    const blockedRequest = page.waitForRequest("**/investments/positions**");

    // Navigate to second investment account
    await page.getByRole("link", { name: "Retirement" }).click();
    await blockedRequest;

    // With stale-while-revalidate, the loading skeleton must NOT appear because
    // positions from the previous account are still displayed
    await expect(
      page.getByTestId("investment-positions-loading")
    ).not.toBeVisible();
    await expect(
      page.getByTestId("investment-positions-section")
    ).toBeVisible();

    await page.unroute("**/investments/positions**");
  });
});
