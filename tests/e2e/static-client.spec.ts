import type { Page } from "@playwright/test";
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

  // In production one process serves the client build and the API on one
  // origin. An API path must get the API, never index.html. The HTTP suite
  // starts the server without a client build, so only this spec checks it.
  test("an API path gets JSON from the API, not the page", async ({ page }) => {
    const accounts = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/b/1/accounts");
    await page.goto("/b/1");
    const response = await accounts;
    expect(new URL(response.url()).origin).toBe(new URL(page.url()).origin);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/json");
    expect(Array.isArray(await response.json())).toBe(true);

    const unknown = await page.request.get("/api/no-such-route");
    expect(unknown.status()).toBe(404);
    expect(unknown.headers()["content-type"] ?? "").not.toContain("text/html");
  });

  test("a chunk that is not there gets 404, not the page", async ({ page }) => {
    const response = await page.request.get("/assets/no-such-chunk-000000.js");
    expect(response.status()).toBe(404);
  });
});

// The Rust server sends the Content-Security-Policy with the page
// (rust-api/server/src/security.rs). The policy must let the app work, and
// it must refuse what it is there to refuse.
test.describe("Content-Security-Policy", () => {
  test.use({ colorScheme: "dark" });

  test("refuses nothing that the pages need", async ({ page, bookId }) => {
    await page.addInitScript(() => {
      const seen: string[] = [];
      (window as unknown as { cspViolations: string[] }).cspViolations = seen;
      document.addEventListener("securitypolicyviolation", (event) =>
        seen.push(`${event.violatedDirective} ${event.blockedURI}`)
      );
    });
    const violations = () =>
      page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations);
    const socket = page.waitForEvent("websocket");

    // The transaction list needs the WASM module, and the book needs its socket.
    await page.goto(`/b/${bookId}/transactions`);
    await expect(page.locator("tbody tr").first()).toBeVisible();
    await socket;
    // The inline theme script ran: its hash is in the policy.
    await expect(page.locator("html")).toHaveClass(/dark/);
    expect(await violations()).toEqual([]);

    await page.goto(`/b/${bookId}/reports`);
    await expect(page.getByRole("heading", { name: "Reports", exact: true })).toBeVisible();
    expect(await violations()).toEqual([]);
  });

  test("refuses an inline script and a request to another host", async ({ page, bookId }) => {
    await page.goto(`/b/${bookId}`);
    const inlineRan = await page.evaluate(() => {
      const script = document.createElement("script");
      script.textContent = "window.inlineRan = true";
      document.head.appendChild(script);
      return (window as unknown as { inlineRan?: boolean }).inlineRan === true;
    });
    expect(inlineRan).toBe(false);
    const outside = await page.evaluate(() =>
      fetch("https://outside.example/").then(() => "sent", () => "refused")
    );
    expect(outside).toBe("refused");
  });
});

// A tab that was open before a deploy asks for chunks that the deploy
// removed. The unit tests of RouteError use a made-up error. These tests make
// the real browser, Vite and React Router give the error, so that an upgrade
// that changes its shape fails here. Issue w74: an installed app on v1.47.0,
// which had no recovery, showed "Unexpected Application Error!".
test.describe("stale chunk after a deploy", () => {
  /**
   * Opens the dashboard, then makes each chunk request get 404, as after a
   * deploy. The 404s stop when the page starts a full load, because a
   * reload gets the new index.html and the new chunk names.
   */
  async function openThenDeploy(page: Page, bookId: number) {
    await page.goto(`/b/${bookId}`);
    await expect(page.getByRole("link", { name: "Securities" }).first()).toBeVisible();
    const deployed = { reloads: 0 };
    page.on("request", (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) deployed.reloads += 1;
    });
    await page.route("**/assets/**", (route) =>
      deployed.reloads === 0 ? route.fulfill({ status: 404, body: "" }) : route.continue()
    );
    return deployed;
  }

  test("a page chunk that is gone reloads the page one time", async ({ page, bookId }) => {
    const deployed = await openThenDeploy(page, bookId);
    await page.getByRole("link", { name: "Securities" }).first().click();

    await expect(page.getByRole("heading", { name: "Securities", exact: true })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/b/${bookId}/securities$`));
    expect(deployed.reloads).toBe(1);
    expect(await page.evaluate(() => performance.getEntriesByType("navigation")[0]?.toJSON().type)).toBe(
      "reload"
    );
  });

  test("a second failure soon after the reload shows the error page", async ({ page, bookId }) => {
    const deployed = await openThenDeploy(page, bookId);
    // An automatic reload occurred a moment ago, so a new one must not start.
    await page.evaluate(() =>
      sessionStorage.setItem("counterpoise:stale-chunk-reload-at", String(Date.now()))
    );
    await page.getByRole("link", { name: "Securities" }).first().click();

    await expect(page.getByRole("heading", { name: "This page did not load" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
    expect(deployed.reloads).toBe(0);
  });
});
