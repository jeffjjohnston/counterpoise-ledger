import { test, expect } from "@playwright/test";

/**
 * Coverage for the "a superseded report request must not paint an error over
 * a fresher one's results" guarantee that the abort guards in
 * app/b/[bookId]/reports/realized-gains/page.tsx exist to protect.
 *
 * The report-fetch effect (~L126-157) aborts the in-flight request whenever
 * the date range changes and issues a new one. If the guard that recognizes
 * "this failure is just my own cancellation" ever fails, the stale request's
 * rejection falls through to the same handling as a genuine failure:
 *
 *   console.error("Failed to load realized gains:", err);
 *   setResult(null);
 *   setError("Failed to load realized gains. Please try again.");
 *   setLoading(false);
 *
 * That's directly user-visible harm on a tax report: the totals the user
 * just navigated to see disappear, replaced by an error banner, even though
 * the newer request already succeeded. This spec drives that exact race in
 * a real browser with page.route() controlling response ordering
 * deterministically (a slow first request held open past a fast second
 * one), so the assertions describe the actual regression a broken guard
 * would produce, not an approximation of it.
 *
 * A Vitest unit test already covers the equivalent scenario by rejecting a
 * mocked fetch directly (tests/app/realized-gains-page.test.tsx, "ignores a
 * stale response..."), but that only exercises the *shape* of the catch
 * block's logic against a promise the test constructs by hand. It cannot
 * exercise real fetch/AbortController semantics — a real network layer,
 * Chromium's own AbortError, a route handler racing an in-flight
 * cancellation. This spec is the only place in the suite that runs the
 * guard against genuine browser abort behavior end to end.
 */
test.describe("realized gains report abort guard", () => {
  test("a slow superseded report request cannot paint an error over a fresher one's totals", async ({
    page,
  }) => {
    // Distinguishable, synthetic totals (not seed data) — each response is
    // otherwise empty (no rows) so the only thing to check is which total
    // ends up on screen.
    const staleBody = {
      rows: [],
      totals: {
        shortTermGainCents: 999900, // $9,999.00 — must never be shown
        longTermGainCents: 0,
        proceedsCents: 0,
        basisCents: 0,
        unknownBasisRows: 0,
      },
    };
    const freshBody = {
      rows: [],
      totals: {
        shortTermGainCents: 123400, // $1,234.00 — the range actually on screen
        longTermGainCents: 0,
        proceedsCents: 0,
        basisCents: 0,
        unknownBasisRows: 0,
      },
    };

    // Holds the first (stale) request's response open until explicitly
    // released, rather than a fixed delay — this is what makes "the second
    // request resolves first" deterministic instead of a real-world timing
    // gamble.
    let releaseStale: () => void = () => {};
    const staleGate = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    // Resolves once the first request's route handler has finished trying
    // to respond — whether that succeeds or throws. Awaiting this instead
    // of a fixed sleep is what makes the final assertions deterministic:
    // the test only checks the end state after the stale response has
    // definitely been given its chance to (wrongly) land.
    let staleAttemptSettled: () => void = () => {};
    const staleAttemptDone = new Promise<void>((resolve) => {
      staleAttemptSettled = resolve;
    });

    let requestCount = 0;
    await page.route("**/api/b/1/reports/realized-gains**", async (route) => {
      requestCount += 1;
      const isFirst = requestCount === 1;

      if (isFirst) {
        await staleGate;
      }

      try {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(isFirst ? staleBody : freshBody),
        });
      } catch {
        // Expected for the first request: by the time the gate releases it,
        // the page has already aborted it (superseded by the date-range
        // change below), so the underlying request is cancelled and
        // fulfilling it throws. That is exactly the case this test exists
        // to cover, not a test infrastructure failure.
      } finally {
        if (isFirst) staleAttemptSettled();
      }
    });

    // The waitForRequest promise must be created BEFORE the action that
    // triggers the request — the request can fire (and be missed) between
    // an action returning and a waitForRequest call made afterward.
    const firstRequestSent = page.waitForRequest("**/api/b/1/reports/realized-gains**");
    await page.goto("/b/1/reports/realized-gains");
    await expect(page.getByRole("heading", { name: "Realized Gains" })).toBeVisible();
    // Confirms the page's own initial-load request is in flight (held open
    // by staleGate) before superseding it.
    await firstRequestSent;

    // Change the date range before the first (stale) request resolves. The
    // report-fetch effect's cleanup aborts it and fires a second request for
    // the new range — the request that must win.
    const secondRequestSent = page.waitForRequest("**/api/b/1/reports/realized-gains**");
    const fromInput = page.getByLabel("From");
    await fromInput.click();
    await fromInput.fill("01/01/2020");
    await secondRequestSent;

    await expect(page.getByTestId("short-term-total")).toHaveText("$1,234.00");

    // Now let the stale first request's delayed response actually try to
    // land.
    releaseStale();
    await staleAttemptDone;

    // The guard must have held. Check the error banner first: under a
    // regression the totals disappear from the DOM entirely (replaced by
    // the error state), so asserting the banner's absence first means a
    // failure here is reported for what it actually is, rather than
    // failing lower down on a missing testid.
    await expect(
      page.getByText("Failed to load realized gains. Please try again.")
    ).not.toBeVisible();
    await expect(page.getByTestId("short-term-total")).toHaveText("$1,234.00");
  });
});
