import { createHash, randomUUID } from "node:crypto";
import { smallBookTest as test, expect } from "./fixtures";
import { exec, insert } from "../helpers/sql";

test("an owner adds a viewer, and the viewer sees the book read-only", async ({ page, browser, bookId }) => {
  const username = `viewer-${randomUUID().slice(0, 8)}`;
  const token = `e2e-viewer-${randomUUID()}`;
  try {
    const user = await insert<{ id: number }>("users", { username, passwordHash: "unused" });
    await insert("sessions", {
      tokenHash: createHash("sha256").update(token).digest("hex"),
      userId: user.id,
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    // The owner (the default E2E user) adds the viewer from Settings.
    await page.goto(`/b/${bookId}/transactions`);
    await page.getByLabel("Open user menu").click();
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("New member role").selectOption("viewer");
    await page.getByRole("button", { name: "Add member" }).click();
    await expect(page.getByText(username)).toBeVisible();

    // The viewer opens the book.
    const context = await browser.newContext({
      storageState: {
        cookies: [{
          name: "counterpoise_session", value: token, domain: "127.0.0.1", path: "/",
          httpOnly: true, secure: false, sameSite: "Lax", expires: Math.floor(Date.now() / 1000) + 86_400,
        }],
        origins: [],
      },
    });
    const viewer = await context.newPage();
    await viewer.goto(`/b/${bookId}/transactions`);
    await expect(viewer.getByText("Read-only")).toBeVisible();
    await expect(viewer.getByRole("button", { name: "Add Transaction" })).toHaveCount(0);

    const denied = await viewer.request.post(`/api/b/${bookId}/accounts`, { data: { name: "Nope", type: "asset" } });
    expect(denied.status()).toBe(403);

    await viewer.goto("/");
    await expect(viewer.getByText("viewer", { exact: true })).toBeVisible();
    await expect(viewer.getByLabel(/^Edit /)).toHaveCount(0);
    await context.close();
  } finally {
    await exec("DELETE FROM users WHERE username = $1", [username]);
  }
});
